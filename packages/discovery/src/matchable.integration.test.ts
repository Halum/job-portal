import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery, type Source } from './index';

const USER = '00000000-0000-4000-8000-000000000001';

const source = (ids: string[]): Source => ({
  id: 'fake',
  fetch: () =>
    Promise.resolve({
      postings: ids.map((id) => ({
        sourcePostingId: id,
        title: `Job ${id}`,
        company: `Firma ${id}`,
        location: 'Musterstadt',
        url: `https://jobs.example.invalid/${id}`,
        raw: { id, text: 'Koch' },
      })),
      errors: [],
    }),
});

describe('what Matching reads from Discovery', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
    discovery = createDiscovery(handle.db, [source(['a', 'b', 'c', 'd', 'e'])]);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('poll names the Jobs of new Postings only', async () => {
    const first = await discovery.poll(USER, 'fake');
    expect(first.jobIds).toHaveLength(5);
    const again = await discovery.poll(USER, 'fake');
    expect(again).toMatchObject({ newPostings: 0, jobIds: [] });
  });

  it('lists Jobs for Matching with the payload, never Dismissed or Expired ones', async () => {
    const { jobs } = await discovery.listJobs(USER, {});
    const ids = jobs.map((j) => j.id);
    await handle.db.execute(
      sql`update discovery.jobs set discovery_state = 'dismissed' where id = ${ids[0] ?? ''}`,
    );
    await handle.db.execute(
      sql`update discovery.jobs set discovery_state = 'expired' where id = ${ids[1] ?? ''}`,
    );
    await handle.db.execute(
      sql`update discovery.jobs set discovery_state = 'shortlisted' where id = ${ids[2] ?? ''}`,
    );

    const matchable = await discovery.listMatchable(USER, ids);
    expect(matchable.map((j) => j.id).sort()).toEqual(ids.slice(2).sort());
    expect(matchable[0]).toMatchObject({
      company: expect.stringMatching(/^Firma/) as string,
      location: 'Musterstadt',
    });
    expect(matchable[0]?.raw).toMatchObject({ text: 'Koch' });
    expect(matchable[0]?.recency).toBeInstanceOf(Date);
    expect(await discovery.listMatchable(USER, [])).toEqual([]);
    expect(await discovery.listMatchable('00000000-0000-4000-8000-000000000002', ids)).toEqual([]);
  });

  it('list_jobs restriction applies before the limit, so a filtered page is full when enough rows match', async () => {
    const all = (await discovery.listJobs(USER, {})).jobs.map((j) => j.id);
    // Restrict to the last three of five Jobs: a page of two must hold two, not fewer.
    const wanted = all.slice(2);
    const first = await discovery.listJobs(USER, { jobIds: wanted, limit: 2 });
    expect(first.jobs.map((j) => j.id)).toEqual(wanted.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await discovery.listJobs(USER, {
      jobIds: wanted,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.jobs.map((j) => j.id)).toEqual(wanted.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it('an empty restriction returns nothing and no restriction returns everything', async () => {
    expect(await discovery.listJobs(USER, { jobIds: [] })).toEqual({ jobs: [], nextCursor: null });
    expect((await discovery.listJobs(USER, { jobIds: null })).jobs).toHaveLength(5);
    expect((await discovery.listJobs(USER, {})).jobs).toHaveLength(5);
  });
});
