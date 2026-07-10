import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createLogger } from '@job-portal/shared';
import type { Database } from '@job-portal/db';
import type { SourceEntry } from '@job-portal/config';
import { createApp } from '../src/app.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/db/drizzle',
);
const bearerToken = 'test-token';
const auth = { Authorization: `Bearer ${bearerToken}` };

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasDocker = dockerAvailable();
if (!hasDocker) console.warn('[s3.integration] Docker not available — skipping');

const T1 = new Date('2026-07-01T00:00:00Z');
const T2 = new Date('2026-07-02T00:00:00Z');
const T3 = new Date('2026-07-03T00:00:00Z');

const sources: SourceEntry[] = [
  { name: 'feki', source_type: 'feki', url: 'https://feki/x', cron: '0 * * * *', enabled: true },
];

describe.skipIf(!hasDocker)('S3 API (Testcontainers pg)', () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let close: () => Promise<void>;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const queued: { name: string; data: unknown }[] = [];

  async function startPg() {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    return new PostgreSqlContainer('postgres:16-alpine').start();
  }

  beforeAll(async () => {
    pg = await startPg();
    const { runMigrationsWithLock, createDbClient, schema, insertError } =
      await import('@job-portal/db');
    await runMigrationsWithLock(pg.getConnectionUri(), { migrationsFolder });
    const client = createDbClient(pg.getConnectionUri());
    close = client.close;
    db = client.db;

    // Seed: three matched jobs at T1/T2/T3, one filtered_out at T2.
    await db.insert(schema.jobs).values([
      {
        source: 'feki',
        externalId: 'm1',
        title: 'M1',
        applyUrl: 'u1',
        raw: { a: 1 },
        status: 'matched',
        enrichedAt: T1,
      },
      {
        source: 'feki',
        externalId: 'm2',
        title: 'M2',
        applyUrl: 'u2',
        raw: {},
        status: 'matched',
        enrichedAt: T2,
      },
      {
        source: 'arbeitsagentur',
        externalId: 'm3',
        title: 'M3',
        applyUrl: 'u3',
        raw: {},
        status: 'matched',
        enrichedAt: T3,
      },
      {
        source: 'feki',
        externalId: 'f1',
        title: 'F1',
        applyUrl: 'u4',
        raw: {},
        status: 'filtered_out',
        enrichedAt: T2,
      },
    ]);
    await insertError(db, {
      source: 'feki',
      jobId: null,
      stage: 'scrape',
      attempts: 3,
      errorMessage: 'scrape boom',
    });
    await insertError(db, {
      source: null,
      jobId: null,
      stage: 'enrichment',
      attempts: 3,
      errorMessage: 'enrich boom',
    });

    app = createApp({
      bearerToken,
      logger: createLogger({ level: 'silent' }),
      db,
      enrichmentQueue: {
        add: async (name: string, data: unknown) => {
          queued.push({ name, data });
          return undefined as never;
        },
      },
      sources,
      health: { checkDb: async () => true, checkRedis: async () => true },
    });
  }, 180_000);

  afterAll(async () => {
    await close?.();
    await pg?.stop();
  });

  it('GET /api/jobs defaults to status=matched, ordered enriched_at ASC', async () => {
    const res = await request(app).get('/api/jobs').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.jobs.map((j: { external_id: string }) => j.external_id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    // snake_case wire contract, no `raw` in list items.
    expect(res.body.jobs[0]).toHaveProperty('apply_url', 'u1');
    expect(res.body.jobs[0]).not.toHaveProperty('raw');
  });

  it('window is [from inclusive, to exclusive)', async () => {
    const res = await request(app)
      .get(`/api/jobs?from=${T2.toISOString()}&to=${T3.toISOString()}`)
      .set(auth);
    expect(res.body.jobs.map((j: { external_id: string }) => j.external_id)).toEqual(['m2']);
  });

  it('source filter narrows the window', async () => {
    const res = await request(app).get('/api/jobs?source=arbeitsagentur').set(auth);
    expect(res.body.jobs.map((j: { external_id: string }) => j.external_id)).toEqual(['m3']);
  });

  it('offset paginates deterministically', async () => {
    const res = await request(app).get('/api/jobs?limit=1&offset=1').set(auth);
    expect(res.body.count).toBe(1);
    expect(res.body.jobs[0].external_id).toBe('m2');
  });

  it('rejects limit above the 500 cap with 400', async () => {
    expect((await request(app).get('/api/jobs?limit=501').set(auth)).status).toBe(400);
  });

  it('GET /api/jobs/:id returns full detail incl. raw, 404 when missing', async () => {
    const list = await request(app).get('/api/jobs?source=feki&status=matched').set(auth);
    const id = list.body.jobs[0].id;
    const res = await request(app).get(`/api/jobs/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('raw');
    expect(res.body).toHaveProperty('status', 'matched');

    expect((await request(app).get('/api/jobs/999999').set(auth)).status).toBe(404);
  });

  it('GET /api/errors windows + filters by stage', async () => {
    const all = await request(app).get('/api/errors').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(2);
    expect(all.body.errors[0]).toHaveProperty('error_message');

    const scrape = await request(app).get('/api/errors?stage=scrape').set(auth);
    expect(scrape.body.count).toBe(1);
    expect(scrape.body.errors[0].stage).toBe('scrape');
  });

  it('POST /api/admin/reenrich with job_ids enqueues one enrich job per id', async () => {
    queued.length = 0;
    const res = await request(app)
      .post('/api/admin/reenrich')
      .set(auth)
      .send({ job_ids: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: 3 });
    expect(queued).toHaveLength(3);
    expect(queued.every((q) => q.name === 'enrich')).toBe(true);
    expect(queued.map((q) => (q.data as { jobId: number }).jobId)).toEqual([1, 2, 3]);
  });

  it('POST /api/admin/reenrich by status selects matching ids', async () => {
    queued.length = 0;
    const res = await request(app)
      .post('/api/admin/reenrich')
      .set(auth)
      .send({ status: 'filtered_out' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1); // only the one filtered_out job
    expect(queued).toHaveLength(1);
  });

  it('POST /api/admin/reenrich accepts but ignores prompt_role', async () => {
    queued.length = 0;
    const res = await request(app)
      .post('/api/admin/reenrich')
      .set(auth)
      .send({ status: 'filtered_out', prompt_role: 'summary' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
  });

  it('POST /api/admin/reenrich 400 on invalid body', async () => {
    const res = await request(app).post('/api/admin/reenrich').set(auth).send({ status: 'nope' });
    expect(res.status).toBe(400);
  });
});
