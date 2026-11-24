import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  createBambaseSource,
  createBundesagenturSource,
  createDiscovery,
  type Discovery,
} from '@job-portal/discovery';
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
const bambaseFixture = readFileSync(
  new URL('../../../packages/discovery/src/sources/fixtures/bambase-jobs.html', import.meta.url),
  'utf8',
);
// Recorded responses by host: no test reaches the network.
const fakeFetch: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.resolve(
    new Response(url.startsWith('https://bambase.de') ? bambaseFixture : fixture, { status: 200 }),
  );
};

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
  const bambase = { sourceId: 'bambase', intervalMinutes: 5 };

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    await runMigrationsWithLock(pg.getConnectionUri(), allMigrations);
    handle = createDb(pg.getConnectionUri());
    discovery = createDiscovery(handle.db, [
      createBundesagenturSource({ query: 'wo=Musterstadt', fetch: fakeFetch }),
      createBambaseSource({ fetch: fakeFetch }),
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

  it('runs bambase on its own schedule and lists it in the run history', async () => {
    worker = await start([bambase]);

    const run = await eventually(async () =>
      (await pipeline.listRuns(USER, 50)).find(
        (r) => r.sourceId === 'bambase' && r.status !== 'running',
      ),
    );
    expect(run).toMatchObject({ status: 'completed', fetched: 12, newPostings: 12, errors: [] });
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect((await queue.getJobSchedulers()).map((s) => [s.key, s.every])).toEqual([
      ['bambase', 300_000],
    ]);
    await queue.close();
  });

  it('registers one scheduler per source, keyed by the source id', async () => {
    worker = await start([bundesagentur, bambase]);
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => [s.key, s.every]).sort()).toEqual([
      ['bambase', 300_000],
      ['bundesagentur', 60_000],
    ]);
    await queue.close();
  });

  it('schedules the Gone cold check next to the sources and runs it on a tick', async () => {
    let runs = 0;
    worker = await startWorker({
      redisUrl: redis.getConnectionUrl(),
      pipeline,
      userId: USER,
      sources: [bambase],
      goneCold: {
        intervalMinutes: 1440,
        run: () => {
          runs += 1;
          return Promise.resolve(0);
        },
      },
      logger,
    });
    await eventually(() => Promise.resolve(runs > 0 ? runs : undefined));
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect((await queue.getJobSchedulers()).map((s) => [s.key, s.every]).sort()).toEqual([
      ['bambase', 300_000],
      ['gone-cold', 86_400_000],
    ]);
    await queue.close();
    await worker.close();
    worker = await start([]);
    const after = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect(await after.getJobSchedulers()).toEqual([]);
    await after.close();
  });

  it('removes the scheduler of a source that is no longer configured', async () => {
    await (await start()).close();
    worker = await start([]);
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect(await queue.getJobSchedulers()).toEqual([]);
    await queue.close();
  });

  it('on start fails runs older than the time bound and leaves a live run of another worker', async () => {
    const hanging = createPipeline(handle.db, { poll: () => new Promise(() => undefined) });
    void hanging.execute(USER, 'left-behind');
    await eventually(async () =>
      (await pipeline.listRuns(USER, 50)).find(
        (r) => r.sourceId === 'left-behind' && r.status === 'running',
      ),
    );
    const statusOf = async (): Promise<string | undefined> =>
      (await pipeline.listRuns(USER, 50)).find((r) => r.sourceId === 'left-behind')?.status;

    await (await start([])).close(); // a second worker starts: the run is fresh, so it survives
    expect(await statusOf()).toBe('running');

    await new Promise((r) => setTimeout(r, 100));
    const impatient = createPipeline(handle.db, discovery, { staleAfterMs: 50 });
    worker = await startWorker({
      redisUrl: redis.getConnectionUrl(),
      pipeline: impatient,
      userId: USER,
      sources: [],
      logger,
    });
    expect(await statusOf()).toBe('failed');
  });

  it('schedules the mail poll beside the sources, runs it, and removes it when unset', async () => {
    let polls = 0;
    worker = await startWorker({
      redisUrl: redis.getConnectionUrl(),
      pipeline,
      userId: USER,
      sources: [],
      mail: {
        intervalMinutes: 10,
        run: () => {
          polls += 1;
          return Promise.resolve();
        },
      },
      logger,
    });
    await eventually(() => Promise.resolve(polls > 0 ? true : undefined));
    const queue = new Queue('pipeline', { connection: new Redis(redis.getConnectionUrl()) });
    expect((await queue.getJobSchedulers()).map((s) => [s.key, s.every])).toEqual([
      ['mail', 600_000],
    ]);
    await worker.close();
    worker = await start([]);
    expect(await queue.getJobSchedulers()).toEqual([]);
    await queue.close();
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
