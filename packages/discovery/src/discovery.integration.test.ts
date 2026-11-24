import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery, type Source } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

function fakeSource(
  postings: { id: string; title: string }[],
  errors: string[] = [],
): Source & { set: (p: { id: string; title: string }[]) => void } {
  let current = postings;
  return {
    id: 'fake',
    set: (p) => {
      current = p;
    },
    fetch: () =>
      Promise.resolve({
        postings: current.map((p) => ({
          sourcePostingId: p.id,
          title: p.title,
          company: 'Beispiel Firma',
          location: 'Musterstadt',
          url: `https://jobs.example.invalid/${p.id}`,
          raw: { id: p.id },
        })),
        errors,
      }),
  };
}

describe('discovery against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let source: ReturnType<typeof fakeSource>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
    source = fakeSource([
      { id: 'a', title: 'First' },
      { id: 'b', title: 'Second' },
    ]);
    discovery = createDiscovery(handle.db, [source]);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('stores each posting and one Job per posting', async () => {
    const result = await discovery.poll(USER, 'fake');
    expect(result).toEqual({
      fetched: 2,
      newPostings: 2,
      jobIds: expect.arrayContaining([expect.any(String), expect.any(String)]) as string[],
      errors: [],
    });
    expect(result.jobIds).toHaveLength(2);

    const { jobs, nextCursor } = await discovery.listJobs(USER, {});
    expect(nextCursor).toBeNull();
    expect(jobs.map((j) => j.title).sort()).toEqual(['First', 'Second']);
    expect(jobs[0]).toMatchObject({ company: 'Beispiel Firma', location: 'Musterstadt' });
  });

  it('re-polling updates the Posting and never inserts a second row', async () => {
    source.set([
      { id: 'a', title: 'First, edited' },
      { id: 'b', title: 'Second' },
      { id: 'c', title: 'Third' },
    ]);
    const result = await discovery.poll(USER, 'fake');
    expect(result).toMatchObject({ fetched: 3, newPostings: 1 });

    const { jobs } = await discovery.listJobs(USER, {});
    expect(jobs).toHaveLength(3);
    const edited = jobs.find((j) => j.postings.some((p) => p.sourcePostingId === 'a'));
    expect(edited?.postings[0]?.title).toBe('First, edited');
  });

  it('two polls at once still leave one row per posting', async () => {
    source.set([{ id: 'race', title: 'Race' }]);
    const results = await Promise.all([discovery.poll(USER, 'fake'), discovery.poll(USER, 'fake')]);
    expect(results.reduce((sum, r) => sum + r.newPostings, 0)).toBe(1);
    const { jobs } = await discovery.listJobs(USER, {});
    expect(jobs.filter((j) => j.title === 'Race')).toHaveLength(1);
  });

  it('passes the source errors through', async () => {
    const noisy = createDiscovery(handle.db, [fakeSource([], ['bad entry'])]);
    expect(await noisy.poll(USER, 'fake')).toEqual({
      fetched: 0,
      newPostings: 0,
      jobIds: [],
      errors: ['bad entry'],
    });
  });

  it('pages Jobs by id with a cursor', async () => {
    const first = await discovery.listJobs(USER, { limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await discovery.listJobs(USER, { limit: 2, cursor: first.nextCursor });
    const ids = [...first.jobs, ...second.jobs].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
  });

  it('gets one Job with its postings, and null for an unknown or foreign Job', async () => {
    const { jobs } = await discovery.listJobs(USER, {});
    const id = jobs[0]?.id ?? '';
    const job = await discovery.getJob(USER, id);
    expect(job?.id).toBe(id);
    expect(job?.postings[0]).toMatchObject({ sourceId: 'fake' });
    expect(await discovery.getJob(OTHER_USER, id)).toBeNull();
    expect(await discovery.getJob(USER, '00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });

  it('scopes every query by user', async () => {
    expect((await discovery.listJobs(OTHER_USER, {})).jobs).toEqual([]);
  });

  it('refuses an unknown source', async () => {
    await expect(discovery.poll(USER, 'nope')).rejects.toThrow(/unknown source/);
  });
});
