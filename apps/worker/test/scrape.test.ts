import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockAgent } from 'undici';
import type { Database } from '@job-portal/db';
import type { RawJob } from '@job-portal/scrapers';
import type { SourceEntry } from '@job-portal/config';
import {
  createScrapeHandler,
  mapRawJobToRow,
  registerScrapeJobs,
  type ScrapePayload,
} from '../src/scrape.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
);

// Minimal real-shaped arbeitsagentur v6 payload — enough to drive the adapter.
const AGENTUR_BODY = {
  ergebnisliste: [
    {
      referenznummer: 'A1',
      stellenangebotsTitel: 'Job A',
      firma: 'Firma A',
      stellenlokationen: [{ adresse: { ort: 'Bamberg' } }],
      datumErsteVeroeffentlichung: '2026-07-01',
    },
    {
      referenznummer: 'A2',
      stellenangebotsTitel: 'Job B',
      firma: 'Firma B',
      stellenlokationen: [{ adresse: { ort: 'Hallstadt' } }],
      datumErsteVeroeffentlichung: '2026-07-02',
    },
  ],
};

const source = (over: Partial<SourceEntry> = {}): SourceEntry => ({
  name: 'src',
  source_type: 'arbeitsagentur',
  url: 'https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg',
  cron: '0 */6 * * *',
  enabled: true,
  ...over,
});

describe('mapRawJobToRow', () => {
  it('maps RawJob to a jobs row, undefined optionals → null, raw passthrough', () => {
    const raw: RawJob = {
      externalId: 'X1',
      title: 'T',
      applyUrl: 'https://e/x1',
      raw: { a: 1 },
    };
    expect(mapRawJobToRow('feki', raw)).toEqual({
      source: 'feki',
      externalId: 'X1',
      title: 'T',
      company: null,
      location: null,
      applyUrl: 'https://e/x1',
      postedAt: null,
      raw: { a: 1 },
    });
  });
});

describe('registerScrapeJobs', () => {
  it('registers repeatables for enabled sources only, with cron + tz + retries', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const sources = [
      source({ name: 'a', enabled: true, cron: '0 7 * * *' }),
      source({ name: 'b', enabled: false }),
      source({ name: 'c', enabled: true, source_type: 'feki', url: 'https://feki/x' }),
    ];

    await registerScrapeJobs({ add }, sources, { attempts: 3, backoff_ms: 5000 });

    expect(add).toHaveBeenCalledTimes(2);
    const names = add.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['a', 'c']);
    const [, payload, opts] = add.mock.calls[0]!;
    expect(payload).toEqual({
      sourceName: 'a',
      sourceType: 'arbeitsagentur',
      url: sources[0]!.url,
    } satisfies ScrapePayload);
    expect(opts.repeat).toEqual({ pattern: '0 7 * * *', tz: 'Europe/Berlin' });
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });
});

// --- Testcontainers (Postgres + Redis) --------------------------------------

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn('[scrape.test] Docker not available — skipping container-backed worker tests');
}

describe.skipIf(!hasDocker)('scrape pipeline (Testcontainers pg + redis)', () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let closeDb: () => Promise<void>;
  let db: Database;
  let mockAgent: MockAgent;

  async function startPg() {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    return new PostgreSqlContainer('postgres:16-alpine').start();
  }
  async function startRedis() {
    const { RedisContainer } = await import('@testcontainers/redis');
    return new RedisContainer('redis:7-alpine').start();
  }

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPg(), startRedis()]);
    // Use @job-portal/db's own migrator/client — worker can't resolve
    // drizzle-orm subpaths directly (transitive dep).
    const { runMigrationsWithLock, createDbClient } = await import('@job-portal/db');
    await runMigrationsWithLock(pg.getConnectionUri(), { migrationsFolder });

    const client = createDbClient(pg.getConnectionUri());
    db = client.db;
    closeDb = client.close;

    // Route the arbeitsagentur adapter's undici calls to the mock.
    const { MockAgent, setGlobalDispatcher } = await import('undici');
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  }, 180_000);

  afterAll(async () => {
    await closeDb?.();
    await pg?.stop();
    await redis?.stop();
  });

  function interceptAgentur(body: unknown) {
    mockAgent
      .get('https://rest.arbeitsagentur.de')
      .intercept({ path: /\/v6\/jobs/, method: 'GET' })
      .reply(200, body);
  }

  it('insertNewJobs dedupes: returns only genuinely-new ids on repeat', async () => {
    const { insertNewJobs } = await import('@job-portal/db');
    const rows = [
      mapRawJobToRow('dd', {
        externalId: 'd1',
        title: 'a',
        applyUrl: 'u',
        raw: {},
      }),
      mapRawJobToRow('dd', {
        externalId: 'd2',
        title: 'b',
        applyUrl: 'u',
        raw: {},
      }),
    ];
    const first = await insertNewJobs(db, rows);
    expect(first).toHaveLength(2);

    const withNew = [
      ...rows,
      mapRawJobToRow('dd', {
        externalId: 'd3',
        title: 'c',
        applyUrl: 'u',
        raw: {},
      }),
    ];
    const second = await insertNewJobs(db, withNew);
    expect(second).toHaveLength(1); // only d3 is new
  });

  it('handler inserts new rows and enqueues enrichment once each; rerun enqueues none', async () => {
    const { Queue, Worker } = await import('bullmq');
    const { createRedisConnection, SCRAPE_QUEUE, ENRICHMENT_QUEUE } =
      await import('@job-portal/shared');
    const { createLogger } = await import('@job-portal/shared');
    const connection = createRedisConnection(redis.getConnectionUrl());

    const scrapeQueue = new Queue(SCRAPE_QUEUE, { connection });
    const enrichmentQueue = new Queue(ENRICHMENT_QUEUE, { connection });
    const handler = createScrapeHandler({
      db,
      enrichmentQueue,
      logger: createLogger({ level: 'silent' }),
    });
    const worker = new Worker<ScrapePayload>(SCRAPE_QUEUE, (job) => handler(job.data), {
      connection,
      concurrency: 1,
    });

    async function runOnce(): Promise<void> {
      const completed = new Promise<void>((resolve, reject) => {
        worker.once('completed', () => resolve());
        worker.once('failed', (_j, e) => reject(e));
      });
      await scrapeQueue.add('run', {
        sourceName: 'ag',
        sourceType: 'arbeitsagentur',
        url: 'https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg',
      } satisfies ScrapePayload);
      await completed;
    }

    interceptAgentur(AGENTUR_BODY);
    await runOnce();
    expect(await enrichmentQueue.getWaitingCount()).toBe(2); // 2 new rows → 2 enrichment jobs

    interceptAgentur(AGENTUR_BODY); // same payload again → all deduped
    await runOnce();
    expect(await enrichmentQueue.getWaitingCount()).toBe(2); // unchanged, no new enqueues

    await worker.close();
    await scrapeQueue.close();
    await enrichmentQueue.close();
    connection.disconnect();
  }, 30_000);
});
