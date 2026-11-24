import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from '@job-portal/shared';

export interface WorkerHandle {
  close: () => Promise<void>;
}

/**
 * Connects to Redis through BullMQ and reports ready. Nothing is scheduled yet: the Pipeline
 * module adds BullMQ job schedulers and processors in a later ticket.
 */
export async function startWorker(
  redisUrl: string,
  logger: Logger,
  connectTimeoutMs = 10_000,
): Promise<WorkerHandle> {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    connectTimeout: connectTimeoutMs,
    retryStrategy: () => null,
  });
  const queue = new Queue('pipeline', { connection });
  const close = async (): Promise<void> => {
    await queue.close();
    connection.disconnect();
  };
  try {
    await queue.waitUntilReady();
  } catch (err) {
    await close();
    throw err;
  }
  logger.info('worker ready, nothing scheduled');
  return { close };
}
