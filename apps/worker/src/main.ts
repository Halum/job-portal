import { createAccounts } from '@job-portal/accounts';
import {
  createAi,
  createAiLog,
  createClaudeRunner,
  createOpenRouterRunner,
  type AiRunner,
} from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createGmailClient, createMail } from '@job-portal/mail';
import { connectRateLimiter, createAiMerge, createDiscovery } from '@job-portal/discovery';
import { createMatching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createTracker } from '@job-portal/tracker';
import { createLogger } from '@job-portal/shared';
import { createGoneColdCheck } from './gone-cold';
import { buildNotifications } from './notifications';
import { buildSources } from './sources';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db } = createDb(config.databaseUrl);
const user = await createAccounts(db, config.mcpBearerToken).seedUser(config.seedUserEmail);

// Targets decide what the Bundesagentur search asks for; Discovery supplies the Jobs Matching may look at.
// A Job with any application status is skipped by matching (hasApplication, from the Tracker).
// (`discovery` and `tracker` are created below; the callbacks only run during a run, after they exist.)
// The AI runner is chosen by config, with no fallback to the other one; without one nothing is scored.
const runner: AiRunner | null =
  config.ai === null
    ? null
    : config.ai.runner === 'openrouter'
      ? createOpenRouterRunner({ apiKey: config.ai.apiKey, model: config.ai.model })
      : createClaudeRunner(config.ai);
const ai = runner === null ? undefined : createAi(createAiLog(db), runner);
const review = createReview(db);
const matching = createMatching(db, {
  ...(ai ? { ai } : {}),
  review,
  defaultAlertThreshold: config.alertThreshold,
  maxCallsPerPass: config.aiMaxCallsPerRun,
  loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
  defaultPrerankTopN: config.prerankTopN,
});

// Company boards: only marked boards of the Board directory (narrowed by the user's Watchlist) are fetched,
// at a bounded rate per ATS host that every worker and the API share through Redis.
const limiter = connectRateLimiter({
  redisUrl: config.redisUrl,
  requestsPerSecond: config.boardRequestsPerSecond,
  onError: (err) => {
    logger.error({ err }, 'rate limit redis error');
  },
});
const { sources, scheduled } = buildSources(config, {
  matching,
  watchlist: createWatchlist(db),
  fetch: limiter.fetch,
  userId: user.id,
});
// Discovery snapshots its Sources, so it is created only now, with every one of them in the list.
const discovery = createDiscovery(db, sources, logger);
const tracker = createTracker(db, discovery);
// Digest and failure alerts go out after each run when a webhook is configured; otherwise the step is skipped.
const notifications = buildNotifications(db, config.notifications, {
  matching,
  discovery,
  review,
  log: logger,
});
// AI merge checks near-duplicate Jobs through the same runner and raises Review items; nothing merges unconfirmed.
const aiMerge = createAiMerge(db, {
  ...(ai ? { ai } : {}),
  review,
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
  minJaccard: config.aiMergeJaccard,
  maxCallsPerPass: config.aiMergeMaxCallsPerRun,
});
// Gmail replies: polled on its own schedule beside the sources. Without Gmail credentials and an AI runner
// the poll is skipped with one log line; a token failure opens the gmail_token alert, never crashes the worker.
const mail = createMail(db, {
  tracker,
  discovery,
  review,
  ...(ai ? { ai } : {}),
  ...(config.gmail && ai
    ? {
        gmail: createGmailClient({
          clientId: config.gmail.clientId,
          clientSecret: config.gmail.clientSecret,
          refreshToken: config.gmail.refreshToken,
        }),
      }
    : {}),
  ...(notifications ? { notify: notifications } : {}),
  ...(config.gmail?.startDate ? { startDate: config.gmail.startDate } : {}),
  maxCallsPerPass: config.aiMailMaxCallsPerRun,
  log: logger,
});
const mailSchedule =
  config.gmail && ai
    ? { intervalMinutes: config.gmail.intervalMinutes, run: () => mail.poll(user.id) }
    : null;
if (mailSchedule === null) {
  logger.info(
    config.gmail
      ? 'Gmail is configured but AI_RUNNER is not: the mail poll is skipped'
      : 'no Gmail credentials: the mail poll is skipped',
  );
}
const pipeline = createPipeline(db, discovery, {
  matching,
  ...(ai ? { scoring: matching, aiMerge } : {}),
  ...(notifications ? { notifications } : {}),
  ...(config.ai ? { aiRunnerName: config.ai.runner } : {}),
});

// The daily Gone cold check: Tracker moves silent applications, Notifications sends one short line each.
const goneCold = createGoneColdCheck({
  tracker,
  matching,
  discovery,
  notifications,
  user,
  log: logger,
});

const worker = await startWorker({
  redisUrl: config.redisUrl,
  pipeline,
  userId: user.id,
  sources: scheduled,
  mail: mailSchedule,
  goneCold: { intervalMinutes: config.goneColdIntervalMinutes, run: goneCold.run },
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(() => {
      limiter.close();
      process.exit(0);
    });
  });
}
