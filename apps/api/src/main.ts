import { createAccounts } from '@job-portal/accounts';
import { createAiLog } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock } from '@job-portal/db';
import { createMail } from '@job-portal/mail';
import { createNotifications } from '@job-portal/notifications';
import {
  connectRateLimiter,
  createAiMerge,
  createDiscovery,
  createRedisLimit,
} from '@job-portal/discovery';
import { createDocuments } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createTracker } from '@job-portal/tracker';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'api' });

await runMigrationsWithLock(config.databaseUrl, allMigrations, logger);
const { db, close: closeDb } = createDb(config.databaseUrl);
const accounts = createAccounts(db, config.mcpBearerToken);
await accounts.seedUser(config.seedUserEmail);

// The API only reads: it has no sources, so it can show runs and jobs but never polls.
const discovery = createDiscovery(db, [], logger);
const tracker = createTracker(db, discovery);
const matching = createMatching(db, {
  loadJobs: (userId, ids) => discovery.listMatchable(userId, ids),
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
  defaultPrerankTopN: config.prerankTopN,
});
const review = createReview(db);
// The API only applies decided ai_merge items (no runner here); the worker raises them.
const aiMerge = createAiMerge(db, {
  review,
  hasApplication: async (userId, ids) => {
    const states = await tracker.getStates(userId, ids);
    return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
  },
});
// Confirming a mail_match item applies the mail and posts one Telegram line. Only sendLines is used here
// (the digest reads belong to the worker), so the tag and Job lookups return nothing.
const notify = config.notifications
  ? createNotifications(db, {
      newTags: () => Promise.resolve([]),
      jobInfo: () => Promise.resolve(null),
      pendingReviews: (userId) => review.countPending(userId),
      webhook: { url: config.notifications.webhookUrl, topicId: config.notifications.topicId },
      maxAttempts: config.notifications.maxAttempts,
      backoffMs: config.notifications.backoffMs,
      log: logger,
    })
  : undefined;
// The API never polls Gmail (no client or runner): it lists unmatched mail and applies decided mail_match items.
const mail = createMail(db, {
  tracker,
  discovery,
  review,
  maxCallsPerPass: config.aiMailMaxCallsPerRun,
  log: logger,
});
const pipeline = createPipeline(db, discovery);
// add_board's verification fetch shares the per-host rate limit with the workers through Redis.
const limiter = connectRateLimiter({
  redisUrl: config.redisUrl,
  requestsPerSecond: config.boardRequestsPerSecond,
  onError: (err) => {
    logger.error({ err }, 'rate limit redis error');
  },
});
// ponytail: 10 add_board attempts per user per hour, fixed in code; make it config if it ever needs tuning
const allowAddBoard = createRedisLimit(limiter.redis, {
  max: 10,
  windowMs: 3_600_000,
  prefix: 'add_board',
});
const server = createApiServer({
  accounts,
  documents: createDocuments(db, {
    hasTarget: async (userId, targetId) =>
      (await matching.listTargets(userId)).some((t) => t.id === targetId),
    hasJob: async (userId, jobId) => (await discovery.getJob(userId, jobId)) !== null,
  }),
  discovery,
  matching,
  pipeline,
  tracker,
  review,
  aiMerge,
  mail,
  ...(notify ? { notify } : {}),
  aiLog: createAiLog(db),
  boards: { watchlist: createWatchlist(db), fetch: limiter.fetch, allowAddBoard },
  logger,
}).listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'api ready, MCP at /mcp');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      limiter.close();
      void closeDb().then(() => process.exit(0));
    });
    server.closeAllConnections();
  });
}
