import { loadConfig } from '@job-portal/config';
import { createLogger } from '@job-portal/shared';
import { composeApp } from './compose';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });

const app = await composeApp(config, logger);

const worker = await startWorker({
  redisUrl: config.redisUrl,
  pipeline: app.pipeline,
  userId: app.user.id,
  sources: app.scheduled,
  mail: app.mailSchedule,
  goneCold: { intervalMinutes: config.goneColdIntervalMinutes, run: app.goneCold.run },
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(async () => {
      await app.close();
      process.exit(0);
    });
  });
}
