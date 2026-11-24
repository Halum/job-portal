import { loadConfig } from '@job-portal/config';
import { createLogger } from '@job-portal/shared';
import { startWorker } from './worker';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: 'worker' });
const worker = await startWorker(config.redisUrl, logger);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.close().then(() => process.exit(0));
  });
}
