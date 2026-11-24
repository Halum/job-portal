import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pipeline } from '@job-portal/pipeline';
import type { Logger } from '@job-portal/shared';

export interface WorkerHandle {
  close: () => Promise<void>;
}

export interface ScheduledSource {
  sourceId: string;
  /** Integer of at least 1; validated by loadConfig. */
  intervalMinutes: number;
}

export interface WorkerOptions {
  redisUrl: string;
  pipeline: Pipeline;
  userId: string;
  sources: ScheduledSource[];
  logger: Logger;
  connectTimeoutMs?: number;
}

const QUEUE = 'pipeline';

/**
 * Marks stale runs failed, then schedules one BullMQ Job Scheduler per source (scheduler id =
 * source id, so re-registering on restart updates it) and runs each tick through the Pipeline.
 * ponytail: concurrency 1, so runs go one at a time; the Pipeline's one-active-run rule is the real guard.
 */
export async function startWorker({
  redisUrl,
  pipeline,
  userId,
  sources,
  logger,
  connectTimeoutMs = 10_000,
}: WorkerOptions): Promise<WorkerHandle> {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    connectTimeout: connectTimeoutMs,
    retryStrategy: () => null,
  });
  const queue = new Queue(QUEUE, { connection });
  let worker: Worker | undefined;
  const close = async (): Promise<void> => {
    await worker?.close();
    await queue.close();
    connection.disconnect();
  };
  try {
    await queue.waitUntilReady();
    const stale = await pipeline.failStaleRuns();
    if (stale > 0) logger.warn({ stale }, 'marked runs left running as failed');

    const wanted = new Set(sources.map((s) => s.sourceId));
    for (const scheduler of await queue.getJobSchedulers()) {
      if (!wanted.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
    }
    for (const { sourceId, intervalMinutes } of sources) {
      await queue.upsertJobScheduler(
        sourceId,
        { every: intervalMinutes * 60_000 },
        { name: sourceId, data: { sourceId } },
      );
    }

    worker = new Worker(
      QUEUE,
      async (job) => {
        const run = await pipeline.execute(userId, job.name);
        if (run === null) logger.warn({ source: job.name }, 'run skipped: one is already active');
        else
          logger.info({ source: job.name, status: run.status, fetched: run.fetched }, 'run done');
      },
      { connection, concurrency: 1 },
    );
    worker.on('error', (err) => {
      logger.error({ err }, 'worker error');
    });
    await worker.waitUntilReady();
  } catch (err) {
    await close();
    throw err;
  }
  logger.info({ sources: sources.map((s) => s.sourceId) }, 'worker ready');
  return { close };
}
