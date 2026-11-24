import { createAccounts, type Accounts, type User } from '@job-portal/accounts';
import {
  createAi,
  createAiLog,
  createClaudeRunner,
  createOpenRouterRunner,
  type AiLog,
  type AiRunner,
} from '@job-portal/ai';
import { createWatchlist, type Watchlist } from '@job-portal/boards';
import type { Config } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createGmailClient, createMail, type Mail } from '@job-portal/mail';
import {
  connectRateLimiter,
  createAiMerge,
  createDiscovery,
  type Discovery,
} from '@job-portal/discovery';
import { createMatching, type Matching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import type { Notifications } from '@job-portal/notifications';
import { createPipeline, type Pipeline } from '@job-portal/pipeline';
import { createReview, type Review } from '@job-portal/review';
import type { Logger } from '@job-portal/shared';
import { createTracker, type Tracker } from '@job-portal/tracker';
import { createGoneColdCheck, type GoneColdCheck } from './gone-cold';
import { buildNotifications } from './notifications';
import { buildSources } from './sources';
import type { ScheduledCheck, ScheduledSource } from './worker';

export interface App {
  accounts: Accounts;
  user: User;
  review: Review;
  matching: Matching;
  discovery: Discovery;
  tracker: Tracker;
  watchlist: Watchlist;
  aiLog: AiLog;
  notifications: Notifications | null;
  mail: Mail;
  /** The Gmail poll as a schedule; null when Gmail or the AI runner is not configured. */
  mailSchedule: ScheduledCheck | null;
  pipeline: Pipeline;
  goneCold: GoneColdCheck;
  /** The Sources as scheduled, one entry per configured Source. */
  scheduled: ScheduledSource[];
  close: () => Promise<void>;
}

/**
 * Migrates, seeds the user and wires every module for the worker process. `fetch` replaces the network for
 * everything that leaves the machine (sources, the AI runner, Gmail, the webhook), so a test or a dry run
 * can stand in for it; unset means the real network.
 */
export async function composeApp(
  config: Config,
  logger: Logger,
  { fetch: fetchImpl }: { fetch?: typeof fetch } = {},
): Promise<App> {
  const net = fetchImpl ? { fetch: fetchImpl } : {};
  await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
  const handle = createDb(config.databaseUrl);
  const { db } = handle;
  const accounts = createAccounts(db, config.mcpBearerToken);
  const user = await accounts.seedUser(config.seedUserEmail);

  // Targets decide what the Bundesagentur search asks for; Discovery supplies the Jobs Matching may look at.
  // The AI runner is chosen by config, with no fallback to the other one; without one nothing is scored.
  const runner: AiRunner | null =
    config.ai === null
      ? null
      : config.ai.runner === 'openrouter'
        ? createOpenRouterRunner({ apiKey: config.ai.apiKey, model: config.ai.model, ...net })
        : createClaudeRunner(config.ai);
  const aiLog = createAiLog(db);
  const ai = runner === null ? undefined : createAi(aiLog, runner);
  const review = createReview(db);
  // A Job with any application status is skipped by matching (hasApplication, from the Tracker).
  // (`discovery` and `tracker` are created below; the callbacks only run during a run, after they exist.)
  const hasApplication = async (userId: string, ids: string[]): Promise<Set<string>> => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  };
  const matching = createMatching(db, {
    ...(ai ? { ai } : {}),
    review,
    defaultAlertThreshold: config.alertThreshold,
    maxCallsPerPass: config.aiMaxCallsPerRun,
    loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
    hasApplication,
    defaultPrerankTopN: config.prerankTopN,
  });

  // Company boards: only marked boards of the Board directory (narrowed by the user's Watchlist) are fetched,
  // at a bounded rate per ATS host that every worker and the API share through Redis.
  const limiter = connectRateLimiter({
    redisUrl: config.redisUrl,
    requestsPerSecond: config.boardRequestsPerSecond,
    ...(fetchImpl ? { inner: fetchImpl } : {}),
    onError: (err) => {
      logger.error({ err }, 'rate limit redis error');
    },
  });
  const watchlist = createWatchlist(db);
  const { sources, scheduled } = buildSources(config, {
    matching,
    watchlist,
    fetch: limiter.fetch,
    userId: user.id,
    ...(fetchImpl ? { directFetch: fetchImpl } : {}),
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
    ...net,
  });
  // AI merge checks near-duplicate Jobs through the same runner and raises Review items; nothing merges unconfirmed.
  const aiMerge = createAiMerge(db, {
    ...(ai ? { ai } : {}),
    review,
    hasApplication,
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
            ...net,
          }),
        }
      : {}),
    ...(notifications ? { notify: notifications } : {}),
    ...(config.gmail?.startDate ? { startDate: config.gmail.startDate } : {}),
    maxCallsPerPass: config.aiMailMaxCallsPerRun,
    maxReadFailures: config.gmailMaxReadFailures,
    log: logger,
  });
  const mailSchedule: ScheduledCheck | null =
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

  return {
    accounts,
    user,
    review,
    matching,
    discovery,
    tracker,
    watchlist,
    aiLog,
    notifications,
    mail,
    mailSchedule,
    pipeline,
    goneCold,
    scheduled,
    close: async () => {
      limiter.close();
      await handle.close();
    },
  };
}
