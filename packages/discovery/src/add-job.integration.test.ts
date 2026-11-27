import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery, type Source } from './index';

let counter = 0;
const freshUser = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

const board: Source = {
  id: 'board',
  fetch: () =>
    Promise.resolve({
      postings: [
        {
          sourcePostingId: 'b1',
          title: 'Backend Entwickler',
          company: 'Beispiel Firma',
          location: 'Musterstadt',
          url: 'https://jobs.example.invalid/b1',
          publisher: 'Beispiel Portal',
          raw: { id: 'b1' },
        },
      ],
      errors: [],
    }),
};

describe('add_job source and seen-before answer', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let d: Discovery;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [discoveryMigrations]);
    handle = createDb(container.getConnectionUri());
    d = createDiscovery(handle.db, [board]);
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const input = { title: 'Koch', company: 'Beispiel GmbH', city: 'Ort' };

  it('a new Job is created and nothing was seen before', async () => {
    const out = await d.addJob(freshUser(), {
      ...input,
      url: 'https://example.invalid/new',
    });
    expect(out).toMatchObject({ created: true, seenBefore: [] });
  });

  it('the same URL again returns the same Job, not created, and the repeat is not its own seenBefore', async () => {
    const user = freshUser();
    const first = await d.addJob(user, { ...input, url: 'https://example.invalid/again' });
    const again = await d.addJob(user, { ...input, url: 'https://example.invalid/again' });
    expect(again).toMatchObject({ jobId: first.jobId, created: false, seenBefore: [] });
  });

  it('a linkedin add stores the site job id, the same job from another host and slug is one Job', async () => {
    const user = freshUser();
    const first = await d.addJob(user, {
      ...input,
      source: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/koch-bei-firma-3801234567?trackingId=x',
    });
    expect(first.created).toBe(true);
    const again = await d.addJob(user, {
      ...input,
      source: 'linkedin',
      url: 'https://de.linkedin.com/jobs/view/3801234567/',
    });
    expect(again).toMatchObject({ jobId: first.jobId, created: false, seenBefore: [] });
    const { jobs } = await d.listJobs(user, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.postings).toMatchObject([
      { sourceId: 'linkedin', sourcePostingId: '3801234567' },
    ]);
  });

  it('an indeed add stores the job key as the source posting id', async () => {
    const user = freshUser();
    const out = await d.addJob(user, {
      ...input,
      source: 'indeed',
      url: 'https://de.indeed.com/viewjob?jk=AbC123def456&from=serp',
    });
    const { jobs } = await d.listJobs(user, {});
    expect(out.created).toBe(true);
    expect(jobs[0]?.postings[0]).toMatchObject({
      sourceId: 'indeed',
      sourcePostingId: 'abc123def456',
    });
  });

  it('refuses a URL that is not a job link of the named site', async () => {
    const user = freshUser();
    await expect(
      d.addJob(user, { ...input, source: 'linkedin', url: 'https://example.invalid/job/1' }),
    ).rejects.toThrow(/linkedin/i);
    await expect(
      d.addJob(user, {
        ...input,
        source: 'indeed',
        url: 'https://www.linkedin.com/jobs/view/3801234567',
      }),
    ).rejects.toThrow(/indeed/i);
    await expect(
      d.addJob(user, { ...input, source: 'linkedin', url: 'https://www.linkedin.com/company/x' }),
    ).rejects.toThrow(/linkedin/i);
  });

  it('a linkedin add of a Job a manual add already made merges and names manual as seenBefore', async () => {
    const user = freshUser();
    const manual = await d.addJob(user, {
      ...input,
      url: 'https://www.linkedin.com/jobs/view/senior-koch-4412345678',
    });
    const out = await d.addJob(user, {
      ...input,
      source: 'linkedin',
      url: 'https://de.linkedin.com/jobs/view/4412345678',
    });
    expect(out.jobId).toBe(manual.jobId);
    expect(out.created).toBe(false);
    expect(out.seenBefore).toHaveLength(1);
    expect(out.seenBefore[0]).toMatchObject({ sourceId: 'manual', publisher: null });
    expect(out.seenBefore[0]?.firstSeenAt).toBeInstanceOf(Date);
  });

  it('seenBefore names a polled Source with its publisher, earliest first', async () => {
    const user = freshUser();
    await d.poll(user, 'board');
    const manual = await d.addJob(user, {
      title: 'Backend Entwickler',
      company: 'Beispiel Firma',
      city: 'Musterstadt',
      url: 'https://elsewhere.example.invalid/x',
    });
    expect(manual.created).toBe(false);
    expect(manual.seenBefore).toMatchObject([{ sourceId: 'board', publisher: 'Beispiel Portal' }]);

    const third = await d.addJob(user, {
      title: 'Backend Entwickler',
      company: 'Beispiel Firma',
      city: 'Musterstadt',
      source: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/5512345678',
    });
    expect(third.created).toBe(false);
    expect(third.seenBefore.map((s) => s.sourceId)).toEqual(['board', 'manual']);
  });

  it('listJobs by url finds the Job on the URL key across hosts and slugs and adds nothing', async () => {
    const user = freshUser();
    const added = await d.addJob(user, {
      ...input,
      source: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/6612345678',
    });
    await d.addJob(user, {
      ...input,
      title: 'Anderer',
      company: 'Andere',
      url: 'https://example.invalid/other',
    });
    const found = await d.listJobs(user, {
      url: 'https://de.linkedin.com/jobs/view/some-slug-6612345678?x=1',
    });
    expect(found.jobs.map((j) => j.id)).toEqual([added.jobId]);
    const miss = await d.listJobs(user, { url: 'https://de.linkedin.com/jobs/view/999' });
    const bad = await d.listJobs(user, { url: 'not a url' });
    const all = await d.listJobs(user, {});
    expect(miss.jobs).toEqual([]);
    expect(bad.jobs).toEqual([]);
    expect(all.jobs).toHaveLength(2);
  });

  it('concurrent adds of one unknown job make one Job and exactly one created answer', async () => {
    const user = freshUser();
    const same = Array.from({ length: 6 }, () =>
      d.addJob(user, {
        ...input,
        source: 'linkedin',
        url: 'https://www.linkedin.com/jobs/view/7712345678',
      }),
    );
    const answers = await Promise.all(same);
    expect(answers.filter((a) => a.created)).toHaveLength(1);
    expect(new Set(answers.map((a) => a.jobId)).size).toBe(1);
    expect(answers.every((a) => a.seenBefore.length === 0)).toBe(true);
    expect((await d.listJobs(user, {})).jobs).toHaveLength(1);
  });

  it('a manual and a linkedin add of the same job at once make one Job, one created, and the other names it', async () => {
    const user = freshUser();
    const [manual, linkedin] = await Promise.all([
      d.addJob(user, { ...input, url: 'https://www.linkedin.com/jobs/view/koch-8812345678' }),
      d.addJob(user, {
        ...input,
        source: 'linkedin',
        url: 'https://de.linkedin.com/jobs/view/8812345678',
      }),
    ]);
    expect([manual.created, linkedin.created].filter(Boolean)).toHaveLength(1);
    expect(manual.jobId).toBe(linkedin.jobId);
    const [creator, joiner] = manual.created ? [manual, linkedin] : [linkedin, manual];
    expect(creator.seenBefore.length).toBeLessThanOrEqual(1);
    expect(joiner.seenBefore).toHaveLength(1);
    expect((await d.listJobs(user, {})).jobs).toHaveLength(1);
  });

  it('listJobs by url never shows another user a Job', async () => {
    const owner = freshUser();
    await d.addJob(owner, { ...input, url: 'https://example.invalid/private' });
    const other = await d.listJobs(freshUser(), { url: 'https://example.invalid/private' });
    expect(other.jobs).toEqual([]);
  });
});
