import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createRequestLog, discoveryMigrations } from './index';

const row = (over: Record<string, unknown>) => ({
  api: 'jsearch' as const,
  keyPosition: 1,
  publisher: null,
  query: 'koch in Musterstadt',
  status: 200,
  failure: null,
  jobsReturned: 3,
  ...over,
});

describe('request log', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('keeps every request with its fields and gives the newest first', async () => {
    const log = createRequestLog(handle.db);
    await log.record(row({ publisher: 'linkedin', status: 429, jobsReturned: 0 }));
    await log.record(
      row({
        api: 'linkedin',
        keyPosition: 2,
        publisher: 'linkedin',
        status: null,
        failure: 'timeout',
        jobsReturned: 0,
      }),
    );
    const recent = await log.recent(2);
    expect(recent).toEqual([
      expect.objectContaining({
        api: 'linkedin',
        keyPosition: 2,
        publisher: 'linkedin',
        query: 'koch in Musterstadt',
        status: null,
        failure: 'timeout',
        jobsReturned: 0,
        requestedAt: expect.any(Date) as Date,
      }),
      expect.objectContaining({
        api: 'jsearch',
        keyPosition: 1,
        publisher: 'linkedin',
        status: 429,
        failure: null,
      }),
    ]);
  });

  it('reads the last slot of each pool back, whatever case the publisher was written in', async () => {
    const log = createRequestLog(handle.db);
    expect(await log.lastSlot('indeed')).toBeNull();
    await log.record(row({ api: 'indeed', keyPosition: 2, publisher: 'Indeed' }));
    await log.record(row({ api: 'jsearch', keyPosition: 2, publisher: 'indeed' }));
    await log.record(row({ api: 'jsearch', keyPosition: 1, publisher: null }));
    await log.record(row({ api: 'jsearch', keyPosition: 2, publisher: 'glassdoor' }));
    await log.record(row({ api: 'jsearch', keyPosition: 1, publisher: 'linkedin' }));
    expect(await log.lastSlot('indeed')).toEqual({ api: 'jsearch', keyPosition: 2 });
    expect(await log.lastSlot('linkedin')).toEqual({ api: 'jsearch', keyPosition: 1 });
    // The jsearch pool is every other publisher and none: its newest row is the glassdoor one.
    expect(await log.lastSlot('jsearch')).toEqual({ api: 'jsearch', keyPosition: 2 });
    await log.record(row({ api: 'jsearch', keyPosition: 1, publisher: null }));
    expect(await log.lastSlot('jsearch')).toEqual({ api: 'jsearch', keyPosition: 1 });
  });
});
