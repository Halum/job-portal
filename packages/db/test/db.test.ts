import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { runMigrationsWithLock } from '../src/migrate.js';
import { createDbClient } from '../src/client.js';
import { insertNewJobs } from '../src/repositories/jobs.js';
import { getPrompt, upsertPrompt } from '../src/repositories/prompts.js';
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

  it('insertNewJobs inserts, dedupes on (source, external_id), returns only new ids', async () => {
    const client = createDbClient(container.getConnectionUri());
    const row = (externalId: string) => ({
      source: 'repo-test',
      externalId,
      title: `Job ${externalId}`,
      company: null,
      location: null,
      applyUrl: `https://e/${externalId}`,
      postedAt: null,
      raw: {},
    });

    const first = await insertNewJobs(client.db, [row('r1'), row('r2')]);
    expect(first).toHaveLength(2);

    // Re-insert the same two plus one new → only the new one comes back.
    const second = await insertNewJobs(client.db, [row('r1'), row('r2'), row('r3')]);
    expect(second).toHaveLength(1);

    // Empty input short-circuits without a query.
    expect(await insertNewJobs(client.db, [])).toEqual([]);

    await client.close();
  });

  it('upsertPrompt inserts, then overwrites in place (one row per source+role)', async () => {
    const client = createDbClient(container.getConnectionUri());
    const db = client.db;

    const created = await upsertPrompt(db, { source: 'feki', role: 'summary', template: 't1' });
    expect(created.template).toBe('t1');
    expect(await getPrompt(db, 'feki', 'summary')).toMatchObject({ template: 't1' });

    // Upsert again for the same (source, role): overwrites template, bumps
    // updated_at, keeps the same id — still exactly one row.
    const updated = await upsertPrompt(db, { source: 'feki', role: 'summary', template: 't2' });
    expect(updated.template).toBe('t2');
    expect(updated.id).toBe(created.id);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const all = await db
      .select()
      .from(schema.prompts)
      .where(and(eq(schema.prompts.source, 'feki'), eq(schema.prompts.role, 'summary')));
    expect(all).toHaveLength(1);

    // Different (source, role) is independent; absent one returns null.
    await upsertPrompt(db, { source: 'arbeitsagentur', role: 'filter', template: 'f1' });
    expect(await getPrompt(db, 'arbeitsagentur', 'filter')).toMatchObject({ template: 'f1' });
    expect(await getPrompt(db, 'arbeitsagentur', 'summary')).toBeNull();

    await client.close();
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
