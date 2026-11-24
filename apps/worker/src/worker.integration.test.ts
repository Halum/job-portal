import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createBundesagenturSource, createDiscovery, type Discovery } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline, type Pipeline } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { startWorker, type WorkerHandle } from './worker';

const USER = '00000000-0000-4000-8000-000000000001';
const fixture = readFileSync(
  new URL(
    '../../../packages/discovery/src/sources/fixtures/bundesagentur-search.json',
    import.meta.url,
  ),
  'utf8',
);
const fakeFetch = (() =>
  Promise.resolve(new Response(fixture, { status: 200 }))) as unknown as typeof fetch;

async function eventually<T>(read: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('worker against real Postgres and Redis', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let pipeline: Pipeline;
  let worker: WorkerHandle | undefined;
  const logger = createLogger({ level: 'silent' });
  const bundesagentur = { sourceId: 'bundesagentur', intervalMinutes: 1 };

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    await runMigrationsWithLock(pg.getConnectionUri(), allMigrations);
    handle = createDb(pg.getConnectionUri());
    discovery = createDiscovery(handle.db, [
      createBundesagenturSource({ query: 'wo=Musterstadt', fetch: fakeFetch }),
    ]);
    pipeline = createPipeline(handle.db, discovery);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await handle.close();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  const start = (sources = [bundesagentur]): Promise<WorkerHandle> =>
    startWorker({ redisUrl: redis.getConnectionUrl(), pipeline, userId: USER, sources, logger });

  it('runs a scheduled source through the Pipeline and stores its postings', async () => {
    worker = await start();

    const run = await eventually(async () =>
      (await pipeline.listRuns(USER, 10)).find((r) => r.status !== 'running'),
    );
    expect(run).toMatchObject({
      sourceId: 'bundesagentur',
      status: 'completed',
      fetched: 5,
      newPostings: 5,
      errors: [],
    });
    expect((await discovery.listJobs(USER, {})).jobs).toHaveLength(5);
  });

  it('registers one scheduler per source, keyed by the source id', async () => {
    worker = await start();
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => [s.key, s.every])).toEqual([['bundesagentur', 60_000]]);
    await queue.close();
  });

  it('removes the scheduler of a source that is no longer configured', async () => {
    await (await start()).close();
    worker = await start([]);
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect(await queue.getJobSchedulers()).toEqual([]);
    await queue.close();
  });

  it('marks runs left running as failed when it starts', async () => {
    const hanging = createPipeline(handle.db, { poll: () => new Promise(() => undefined) });
    void hanging.execute(USER, 'left-behind');
    await eventually(async () =>
      (await pipeline.listRuns(USER, 50)).find(
        (r) => r.sourceId === 'left-behind' && r.status === 'running',
      ),
    );

    worker = await start([]);

    const runs = await pipeline.listRuns(USER, 50);
    expect(runs.find((r) => r.sourceId === 'left-behind')).toMatchObject({ status: 'failed' });
  });

  it('fails fast when Redis is unreachable', async () => {
    await expect(
      startWorker({
        redisUrl: 'redis://127.0.0.1:1',
        pipeline,
        userId: USER,
        sources: [],
        logger,
        connectTimeoutMs: 500,
      }),
    ).rejects.toThrow();
  });
});
