import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { runMigrationsWithLock } from '../src/migrate.js';
import { createDbClient } from '../src/client.js';
import * as schema from '../src/schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, '..', 'drizzle');

// These tests spin up a real Postgres via Testcontainers, which requires a
// working Docker daemon. We probe synchronously at collection time (rather
// than inside beforeAll) because Vitest's describe.skipIf needs its
// condition known before tests run. If Docker isn't reachable here, the
// whole suite is skipped rather than failing the run.
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();

if (!dockerAvailable) {
  console.warn('[db.test] Docker not available — skipping Testcontainers-backed DB tests');
}

describe.skipIf(!dockerAvailable)('db migrations + constraints (Testcontainers)', () => {
  let container: Awaited<ReturnType<typeof startContainer>>;

  async function startContainer() {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    return new PostgreSqlContainer('postgres:16-alpine').start();
  }

  beforeAll(async () => {
    container = await startContainer();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('applies migrations cleanly', async () => {
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder });

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;
    const tableNames = tables.map((t) => t.table_name).sort();
    expect(tableNames).toEqual(['errors', 'jobs', 'prompts']);
    await sql.end();
  });

  it('enforces the (source, external_id) unique constraint on jobs', async () => {
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    const db = drizzle(sql, { schema });

    await db.insert(schema.jobs).values({
      source: 'arbeitsagentur',
      externalId: 'abc-123',
      title: 'Software Engineer',
      applyUrl: 'https://example.com/jobs/abc-123',
      raw: { title: 'Software Engineer' },
    });

    await expect(
      db.insert(schema.jobs).values({
        source: 'arbeitsagentur',
        externalId: 'abc-123',
        title: 'Duplicate',
        applyUrl: 'https://example.com/jobs/abc-123',
        raw: { title: 'Duplicate' },
      }),
    ).rejects.toThrow();

    await sql.end();
  });

  it('enforces only one active prompt per (source, role)', async () => {
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    const db = drizzle(sql, { schema });

    await db.insert(schema.prompts).values({
      source: 'feki',
      role: 'filter',
      version: 1,
      template: 'v1 template',
      isActive: true,
    });

    await expect(
      db.insert(schema.prompts).values({
        source: 'feki',
        role: 'filter',
        version: 2,
        template: 'v2 template',
        isActive: true,
      }),
    ).rejects.toThrow();

    // A second inactive version for the same source+role is fine.
    await db.insert(schema.prompts).values({
      source: 'feki',
      role: 'filter',
      version: 2,
      template: 'v2 template',
      isActive: false,
    });

    await sql.end();
  });

  it('createDbClient connects, queries, and closes cleanly', async () => {
    const client = createDbClient(container.getConnectionUri());
    const rows = await client.sql`select 1 as one`;
    expect(rows[0]?.one).toBe(1);
    await client.close();
  });

  it('advisory-lock migration runner: concurrent callers do not race', async () => {
    const uri = container.getConnectionUri();

    // Migrations already ran against this container in an earlier test, so
    // this mainly verifies both calls resolve cleanly without deadlocking or
    // throwing due to the lock contention itself.
    await expect(
      Promise.all([
        runMigrationsWithLock(uri, { migrationsFolder }),
        runMigrationsWithLock(uri, { migrationsFolder }),
      ]),
    ).resolves.toBeDefined();
  }, 30_000);
});
