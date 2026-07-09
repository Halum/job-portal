import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createLogger } from '@job-portal/shared';
import type { Database } from '@job-portal/db';
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
if (!hasDocker) {
  console.warn('[prompts.integration] Docker not available — skipping');
}

describe.skipIf(!hasDocker)('/api/prompts (Testcontainers pg)', () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;

  async function startPg() {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    return new PostgreSqlContainer('postgres:16-alpine').start();
  }

  beforeAll(async () => {
    pg = await startPg();
    const { runMigrationsWithLock, createDbClient } = await import('@job-portal/db');
    await runMigrationsWithLock(pg.getConnectionUri(), { migrationsFolder });
    const client = createDbClient(pg.getConnectionUri());
    close = client.close;
    app = createApp({
      bearerToken,
      logger: createLogger({ level: 'silent' }),
      db: client.db as Database,
      health: { checkDb: async () => true, checkRedis: async () => true },
    });
  }, 180_000);

  afterAll(async () => {
    await close?.();
    await pg?.stop();
  });

  it('GET 404 when absent, POST upserts (200), POST again overwrites, GET 200', async () => {
    const missing = await request(app).get('/api/prompts?source=feki&role=filter').set(auth);
    expect(missing.status).toBe(404);

    const created = await request(app)
      .post('/api/prompts')
      .set(auth)
      .send({ source: 'feki', role: 'filter', template: 'v1 template' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ source: 'feki', role: 'filter', template: 'v1 template' });

    const overwrite = await request(app)
      .post('/api/prompts')
      .set(auth)
      .send({ source: 'feki', role: 'filter', template: 'v2 template' });
    expect(overwrite.status).toBe(200);
    expect(overwrite.body.id).toBe(created.body.id); // same row, destructive
    expect(overwrite.body.template).toBe('v2 template');

    const got = await request(app).get('/api/prompts?source=feki&role=filter').set(auth);
    expect(got.status).toBe(200);
    expect(got.body.template).toBe('v2 template');
  });

  it('POST invalid body → 400', async () => {
    const res = await request(app)
      .post('/api/prompts')
      .set(auth)
      .send({ source: 'feki', role: 'filter' }); // missing template
    expect(res.status).toBe(400);
  });
});
