import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery, type Source } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

interface Fake {
  id: string;
  title: string;
  company?: string;
  location?: string;
  url?: string;
}

function fakeSource(sourceId: string, initial: Fake[]): Source & { set: (p: Fake[]) => void } {
  let current = initial;
  return {
    id: sourceId,
    set: (p) => {
      current = p;
    },
    fetch: () =>
      Promise.resolve({
        postings: current.map((p) => ({
          sourcePostingId: p.id,
          title: p.title,
          company: p.company,
          location: p.location,
          url: p.url ?? `https://${sourceId}.example.invalid/${p.id}`,
          raw: { id: p.id },
        })),
        errors: [],
      }),
  };
}

describe('rule merge, split and add_job against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let n = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  /** A fresh user per test keeps the tests independent. */
  const freshUser = (): string => `00000000-0000-4000-8000-${String(++n + 100).padStart(12, '0')}`;
  const jobsOf = async (d: Discovery, user: string) => (await d.listJobs(user, {})).jobs;

  it('merges postings of the same company, title and city into one Job', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      { id: '1', title: 'Koch (m/w/d)', company: 'Beispiel GmbH', location: 'Musterstadt' },
    ]);
    const b = fakeSource('beta', [
      { id: '9', title: 'Koch', company: 'BEISPIEL', location: 'Musterstadt' },
    ]);
    const d = createDiscovery(handle.db, [a, b]);
    await d.poll(user, 'alpha');
    const second = await d.poll(user, 'beta');
    expect(second.newPostings).toBe(1);

    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.postings.map((p) => p.sourceId).sort()).toEqual(['alpha', 'beta']);
    const detail = await d.getJob(user, jobs[0]?.id ?? '');
    expect(detail?.postings).toHaveLength(2);
  });

  it('merges on the cleaned URL when the titles differ', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      { id: '1', title: 'Koch', url: 'https://x.example.invalid/j/5' },
    ]);
    const b = fakeSource('beta', [
      {
        id: '2',
        title: 'Küchenchef',
        url: 'https://www.x.example.invalid/j/5/?utm_source=feed#top',
      },
    ]);
    const d = createDiscovery(handle.db, [a, b]);
    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    expect(await jobsOf(d, user)).toHaveLength(1);
  });

  it('does not use the company key when the city is missing', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [{ id: '1', title: 'Koch', company: 'Beispiel GmbH' }]);
    const b = fakeSource('beta', [{ id: '2', title: 'Koch', company: 'Beispiel GmbH' }]);
    const d = createDiscovery(handle.db, [a, b]);
    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    expect(await jobsOf(d, user)).toHaveLength(2);
  });

  it('never merges across users', async () => {
    const f = { id: '1', title: 'Koch', company: 'Beispiel GmbH', location: 'Musterstadt' };
    const d = createDiscovery(handle.db, [fakeSource('alpha', [f])]);
    await d.poll(USER, 'alpha');
    await d.poll(OTHER_USER, 'alpha');
    expect(await jobsOf(d, USER)).toHaveLength(1);
    expect(await jobsOf(d, OTHER_USER)).toHaveLength(1);
  });

  it('merges nothing when the two keys hit different Jobs, and records the case', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      {
        id: '1',
        title: 'Koch',
        company: 'Alpha GmbH',
        location: 'Ort',
        url: 'https://a.example.invalid/1',
      },
    ]);
    const b = fakeSource('beta', [
      {
        id: '2',
        title: 'Anderes',
        company: 'Beta GmbH',
        location: 'Dort',
        url: 'https://b.example.invalid/2',
      },
    ]);
    const c = fakeSource('gamma', [
      {
        id: '3',
        title: 'Koch',
        company: 'Alpha',
        location: 'Ort',
        url: 'https://b.example.invalid/2',
      },
    ]);
    const d = createDiscovery(handle.db, [a, b, c]);
    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    const conflictRows = async () =>
      await handle.db.execute<{ posting_id: string; job_ids: string[] }>(
        sql`select posting_id, job_ids from discovery.merge_conflicts where user_id = ${user}`,
      );
    expect(await conflictRows()).toHaveLength(0);
    await d.poll(user, 'gamma');

    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(3);
    const conflicts = await conflictRows();
    expect(conflicts).toHaveLength(1);
    const gammaJob = jobs.find((j) => j.postings.some((p) => p.sourceId === 'gamma'));
    expect(gammaJob?.postings).toHaveLength(1);
    expect(conflicts[0]?.posting_id).toBe(gammaJob?.postings[0]?.id);
    expect([...(conflicts[0]?.job_ids ?? [])].sort()).toEqual(
      jobs
        .filter((j) => j !== gammaJob)
        .map((j) => j.id)
        .sort(),
    );
  });

  it('split moves Postings to a new Job, the next run does not re-merge, and splits are counted', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      { id: '1', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const b = fakeSource('beta', [
      { id: '2', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const d = createDiscovery(handle.db, [a, b]);
    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    const [merged] = await jobsOf(d, user);
    const betaPosting = merged?.postings.find((p) => p.sourceId === 'beta');

    const result = await d.splitJob(user, merged?.id ?? '', [betaPosting?.id ?? '']);
    expect(result.splitCount).toBe(1);
    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === result.jobId)?.postings.map((p) => p.sourceId)).toEqual([
      'beta',
    ]);

    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    expect(await jobsOf(d, user)).toHaveLength(2);
    expect(await d.getJob(user, result.jobId)).toMatchObject({ postings: [{ sourceId: 'beta' }] });
  });

  it('split refuses to empty a Job, foreign Postings and other users', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      { id: '1', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const b = fakeSource('beta', [
      { id: '2', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const c = fakeSource('gamma', [{ id: '3', title: 'Spüler' }]);
    const d = createDiscovery(handle.db, [a, b, c]);
    await d.poll(user, 'alpha');
    await d.poll(user, 'beta');
    await d.poll(user, 'gamma');
    const jobs = await jobsOf(d, user);
    const merged = jobs.find((j) => j.postings.length === 2);
    const other = jobs.find((j) => j.postings.length === 1);
    const both = merged?.postings.map((p) => p.id) ?? [];

    await expect(d.splitJob(user, merged?.id ?? '', both)).rejects.toThrow(/every posting/);
    await expect(
      d.splitJob(user, merged?.id ?? '', [other?.postings[0]?.id ?? '']),
    ).rejects.toThrow(/not a posting of this job/);
    await expect(d.splitJob(user, merged?.id ?? '', [])).rejects.toThrow(/at least one/);
    await expect(d.splitJob(OTHER_USER, merged?.id ?? '', [both[0] ?? ''])).rejects.toThrow(
      /No Job/,
    );
    expect(await jobsOf(d, user)).toHaveLength(2);
  });

  it('a Dismissed Job stays a marker: matching Postings never create a new Job', async () => {
    const user = freshUser();
    const a = fakeSource('alpha', [
      { id: '1', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const b = fakeSource('beta', [
      { id: '2', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const d = createDiscovery(handle.db, [a, b]);
    await d.poll(user, 'alpha');
    const [job] = await jobsOf(d, user);
    await handle.db.execute(
      sql`update discovery.jobs set discovery_state = 'dismissed' where id = ${job?.id ?? ''}`,
    );
    await d.poll(user, 'beta');
    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.postings).toHaveLength(2);
  });

  it('add_job creates a manual Posting, is idempotent, and a later board copy merges with it', async () => {
    const user = freshUser();
    const board = fakeSource('beta', [
      { id: '2', title: 'Koch', company: 'Beispiel GmbH', location: 'Ort' },
    ]);
    const d = createDiscovery(handle.db, [board]);
    const input = {
      title: 'Koch',
      company: 'Beispiel GmbH',
      city: 'Ort',
      url: 'https://x.example.invalid/j/1',
    };
    const first = await d.addJob(user, input);
    const again = await d.addJob(user, {
      ...input,
      url: 'https://x.example.invalid/j/1/?utm_source=m',
    });
    expect(again.jobId).toBe(first.jobId);

    await d.poll(user, 'beta');
    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.postings.map((p) => p.sourceId).sort()).toEqual(['beta', 'manual']);
  });

  it('add_job refuses a URL that is not absolute http(s)', async () => {
    const d = createDiscovery(handle.db, []);
    await expect(
      d.addJob(freshUser(), { title: 'Koch', company: 'X', city: 'Ort', url: 'nope' }),
    ).rejects.toThrow(/url/i);
  });

  it('concurrent runs of different sources never create duplicate Jobs', async () => {
    const user = freshUser();
    const rows = (prefix: string): Fake[] =>
      Array.from({ length: 25 }, (_, i) => ({
        id: `${prefix}${String(i)}`,
        title: `Titel ${String(i)}`,
        company: 'Beispiel GmbH',
        location: 'Ort',
      }));
    const sources = ['s1', 's2', 's3'].map((id) => fakeSource(id, rows(id)));
    const d1 = createDiscovery(handle.db, sources);
    const d2 = createDiscovery(handle.db, sources);

    await Promise.all([
      d1.poll(user, 's1'),
      d2.poll(user, 's2'),
      d1.poll(user, 's3'),
      d2.poll(user, 's1'),
      d1.poll(user, 's2'),
    ]);

    const jobs = await jobsOf(d1, user);
    expect(jobs).toHaveLength(25);
    for (const j of jobs) expect(j.postings).toHaveLength(3);
  });

  it('a Job that took a copy by company key also takes a later copy sharing the first copy URL, whatever its title', async () => {
    const user = freshUser();
    const a = fakeSource('one', [
      {
        id: '1',
        title: 'Koch',
        company: 'Beispiel',
        location: 'Ort',
        url: 'https://x.example.invalid/1',
      },
    ]);
    // same company key, other URL: attaches to the Job, which keeps only the first URL as its own key
    const b = fakeSource('two', [
      {
        id: '2',
        title: 'Koch',
        company: 'Beispiel',
        location: 'Ort',
        url: 'https://x.example.invalid/2',
      },
    ]);
    // other company key and title, but the URL of the second copy
    const c = fakeSource('three', [
      {
        id: '3',
        title: 'Aushilfe Lager',
        company: 'Anders',
        location: 'Elsewhere',
        url: 'https://x.example.invalid/2',
      },
    ]);
    const d = createDiscovery(handle.db, [a, b, c]);
    await d.poll(user, 'one');
    await d.poll(user, 'two');
    await d.poll(user, 'three');
    const jobs = await jobsOf(d, user);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.postings).toHaveLength(3);
  });
});
