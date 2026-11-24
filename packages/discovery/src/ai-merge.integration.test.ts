import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { AiError, type Ai } from '@job-portal/ai';
import { createReview, mergeSubject, reviewMigrations, type Review } from '@job-portal/review';
import {
  createAiMerge,
  createDiscovery,
  discoveryMigrations,
  type AiMerge,
  type Discovery,
  type Source,
} from './index';

const OTHER = '00000000-0000-4000-8000-0000000000aa';

interface Fake {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
}
const posting = (id: string, f: Partial<Fake> = {}): Fake => ({
  id,
  title: 'Alpha Developer Backend',
  company: 'Beispiel Firma GmbH',
  location: 'Bamberg',
  url: `https://jobs.example.invalid/${id}`,
  ...f,
});
const source = (id: string, list: Fake[]): Source => ({
  id,
  fetch: () =>
    Promise.resolve({
      postings: list.map((p) => ({
        sourcePostingId: p.id,
        title: p.title,
        company: p.company,
        location: p.location,
        url: p.url,
        raw: { id: p.id },
      })),
      errors: [],
    }),
});

describe('AI merge against real Postgres and a faked runner', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let review: Review;
  let n = 0;
  let answer: (prompt: string) => boolean | Error = () => true;
  let model = 'vendor/model-a';
  let calls = 0;
  let applied = new Set<string>();

  const ai: Ai = {
    run(_user, feature, prompt, parse) {
      calls += 1;
      expect(feature).toBe('ai_merge');
      const a = answer(prompt);
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve({
        value: parse(JSON.stringify({ same: a, reason: 'r' })),
        model,
        costUsd: 0.01,
      });
    },
  };
  const fresh = (): string => `00000000-0000-4000-8000-${String(++n + 500).padStart(12, '0')}`;

  /** A user with the given postings (one source per posting, so each is polled on its own). */
  async function setup(
    user: string,
    postings: Fake[],
  ): Promise<{ discovery: Discovery; merge: AiMerge }> {
    const sources = postings.map((p, i) => source(`s${String(i)}`, [p]));
    const discovery = createDiscovery(handle.db, sources);
    for (const [i] of postings.entries()) await discovery.poll(user, `s${String(i)}`);
    const merge = createAiMerge(handle.db, {
      ai,
      review,
      hasApplication: (_u, ids) => Promise.resolve(new Set(ids.filter((id) => applied.has(id)))),
    });
    return { discovery, merge };
  }
  const decide = (user: string, merge: AiMerge, id: string, d: 'confirm' | 'disagree') =>
    review.decide(user, id, d, (item, tx, decision) =>
      merge.apply(tx, user, item.subject, decision),
    );
  const pending = async (user: string) => (await review.list(user, { limit: 100 })).items;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      discoveryMigrations,
      reviewMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    review = createReview(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const reset = (): void => {
    answer = () => true;
    model = 'vendor/model-a';
    calls = 0;
    applied = new Set();
  };

  it('a near match creates one ai_merge item with the model and merges nothing', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    const result = await merge.run(user);
    expect(result).toMatchObject({ calls: 1, items: 1, errors: [] });
    expect(result.costUsd).toBe(0.01);
    const items = await pending(user);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'ai_merge',
      status: 'pending',
      model: 'vendor/model-a',
    });
    expect(
      mergeSubject.parse(items[0]?.subject).jobA < mergeSubject.parse(items[0]?.subject).jobB,
    ).toBe(true);
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(2);
    // a second run asks nothing: the pair already has an item
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
  });

  it('titles below the overlap value and other companies or cities are never asked', async () => {
    reset();
    const user = fresh();
    const { merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Gardener' }),
      posting('c', { company: 'Andere Firma', title: 'Alpha Developer Backend Senior' }),
      posting('d', { location: 'Köln', title: 'Alpha Developer Backend Senior' }),
    ]);
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
  });

  it('a not-the-same answer stores no item and is not asked again', async () => {
    reset();
    answer = () => false;
    const user = fresh();
    const { merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    expect(await merge.run(user)).toMatchObject({ calls: 1, items: 0 });
    expect(await pending(user)).toHaveLength(0);
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
  });

  it('skips a pair covered by a never-merge pair from a split', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { url: 'https://other.example.invalid/b' }),
    ]);
    const job = (await discovery.listJobs(user, {})).jobs[0];
    expect(job?.postings).toHaveLength(2); // same company key: one Job
    const second = job?.postings[1]?.id ?? '';
    await discovery.splitJob(user, job?.id ?? '', [second]);
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(2);
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
  });

  it('a merge conflict row becomes a candidate pair', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('x', { url: 'https://x.example.invalid/1' }),
      posting('y', {
        company: 'Andere Firma',
        title: 'Beta Tester',
        location: 'Köln',
        url: 'https://y.example.invalid/2',
      }),
      // company key of x, URL of y: the keys hit two Jobs
      posting('z', { url: 'https://y.example.invalid/2' }),
    ]);
    expect(await discovery.listMergeConflicts(user)).toHaveLength(1);
    const jobs = (await discovery.listJobs(user, {})).jobs;
    const xy = jobs.filter((j) => j.postings.some((p) => ['x', 'y'].includes(p.sourcePostingId)));
    const result = await merge.run(user);
    const subjects = (await pending(user)).map((i) => mergeSubject.parse(i.subject));
    const [a, b] = xy.map((j) => j.id).sort();
    expect(subjects).toContainEqual({ jobA: a, jobB: b });
    expect(result.items).toBe(subjects.length);
  });

  it('confirm merges the Postings into the older Job and closes the URL key chain', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a', { url: 'https://jobs.example.invalid/one' }),
      // same company key: attaches to a's Job, whose URL key stays the one of a
      posting('b', { url: 'https://jobs.example.invalid/two' }),
      // other title, so another company key; its URL is b's, which the Job never got
      posting('c', {
        title: 'Alpha Developer Backend Senior',
        url: 'https://jobs.example.invalid/two',
      }),
    ]);
    const before = (await discovery.listJobs(user, {})).jobs;
    expect(before).toHaveLength(2);
    await merge.run(user);
    const [item] = await pending(user);
    expect(item).toBeDefined();
    await decide(user, merge, item?.id ?? '', 'confirm');
    const after = (await discovery.listJobs(user, {})).jobs;
    expect(after).toHaveLength(1);
    const [older, newer] = [...before].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
    );
    expect(after[0]?.id).toBe(older?.id); // the older Job stays
    expect(after[0]?.postings.map((p) => p.sourcePostingId).sort()).toEqual(['a', 'b', 'c']);
    expect(await discovery.getJob(user, newer?.id ?? '')).toBeNull();
    // the folded Job's URL key still leads to the kept Job: a later posting with that URL and another title attaches
    const later = createDiscovery(handle.db, [
      source('late', [
        posting('d', { title: 'Something Else', url: 'https://jobs.example.invalid/two' }),
      ]),
    ]);
    await later.poll(user, 'late');
    const final = (await discovery.listJobs(user, {})).jobs;
    expect(final).toHaveLength(1);
    expect(final[0]?.postings).toHaveLength(4);
  });

  it('disagree records never-merge pairs and a later run does not ask again', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    await merge.run(user);
    const [item] = await pending(user);
    await decide(user, merge, item?.id ?? '', 'disagree');
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(2);
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
    // even with the item gone from the picture, the never-merge pair alone keeps the pair out
    expect(calls).toBe(1);
  });

  it('confirm keeps the Job that has an application, even when it is the newer one', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    const jobs = (await discovery.listJobs(user, {})).jobs;
    const [older, newer] = [...jobs].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    applied = new Set([newer?.id ?? '']);
    expect(await merge.run(user)).toMatchObject({ calls: 1, items: 1 });
    const [item] = await pending(user);
    await decide(user, merge, item?.id ?? '', 'confirm');
    const after = (await discovery.listJobs(user, {})).jobs;
    expect(after.map((j) => j.id)).toEqual([newer?.id]);
    expect(after[0]?.postings).toHaveLength(2);
    expect(await discovery.getJob(user, older?.id ?? '')).toBeNull();
    // no writer can reach the folded Job any more
    const locked = await handle.db.transaction((tx) =>
      discovery.lockJob(tx, user, older?.id ?? ''),
    );
    expect(locked).toBeNull();
  });

  it('two Jobs that both have an application are never asked about, and a confirm of one is refused with the reason', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    await merge.run(user);
    const [item] = await pending(user);
    const jobs = (await discovery.listJobs(user, {})).jobs;
    applied = new Set(jobs.map((j) => j.id));
    await expect(decide(user, merge, item?.id ?? '', 'confirm')).rejects.toThrow(
      /both Jobs have an application.*disagree instead/,
    );
    expect(await pending(user)).toHaveLength(1);
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(2);
    // disagree is the way out
    await decide(user, merge, item?.id ?? '', 'disagree');
    expect(await pending(user)).toHaveLength(0);
    // and a fresh pair of such Jobs costs no AI call
    const other = fresh();
    const two = await setup(other, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    applied = new Set((await two.discovery.listJobs(other, {})).jobs.map((j) => j.id));
    calls = 0;
    expect(await two.merge.run(other)).toMatchObject({ calls: 0, items: 0 });
  });

  it('confirm is refused with the reason when a Job was dismissed since the check', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    await merge.run(user);
    const [item] = await pending(user);
    const first = (await discovery.listJobs(user, {})).jobs[0];
    await handle.db.transaction((tx) =>
      discovery.setDiscoveryState(tx, user, first?.id ?? '', 'dismissed'),
    );
    await expect(decide(user, merge, item?.id ?? '', 'confirm')).rejects.toThrow(
      /dismissed or expired.*disagree instead/,
    );
    expect(await pending(user)).toHaveLength(1);
  });

  it('confirm is refused with the reason when a disagreed pair now bars it', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
      posting('c', { title: 'Alpha Developer Backend Lead' }),
    ]);
    expect(await merge.run(user)).toMatchObject({ items: 3 });
    const [j0, j1, j2] = [...(await discovery.listJobs(user, {})).jobs].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
    );
    const items = await pending(user);
    const itemOf = (x: string, y: string) =>
      items.find((i) => {
        const s = mergeSubject.parse(i.subject);
        return [s.jobA, s.jobB].sort().join() === [x, y].sort().join();
      });
    // the user says j1 and j2 are different, then merges j1 into j0: j2 is now barred from j0 as well
    await decide(user, merge, itemOf(j1?.id ?? '', j2?.id ?? '')?.id ?? '', 'disagree');
    await decide(user, merge, itemOf(j0?.id ?? '', j1?.id ?? '')?.id ?? '', 'confirm');
    const stale = itemOf(j0?.id ?? '', j2?.id ?? '');
    await expect(decide(user, merge, stale?.id ?? '', 'confirm')).rejects.toThrow(
      /keeps these Jobs apart.*disagree instead/,
    );
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(2);
  });

  it('skips a pair only when both Jobs have an application', async () => {
    reset();
    const user = fresh();
    const { discovery, merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    const jobs = (await discovery.listJobs(user, {})).jobs;
    applied = new Set(jobs.map((j) => j.id));
    expect(await merge.run(user)).toMatchObject({ calls: 0, items: 0 });
    applied = new Set([jobs[0]?.id ?? '']);
    expect(await merge.run(user)).toMatchObject({ calls: 1, items: 1 });
  });

  it("never reads or merges another user's Jobs", async () => {
    reset();
    const user = fresh();
    const other = fresh();
    const mine = await setup(user, [posting('a')]);
    const theirs = await setup(other, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    expect(await mine.merge.run(user)).toMatchObject({ calls: 0, items: 0 });
    // an item of mine that names the other user's Jobs changes nothing there
    const jobs = (await theirs.discovery.listJobs(other, {})).jobs.map((j) => j.id).sort();
    const forged = await review.create(user, {
      kind: 'ai_merge',
      subject: { jobA: jobs[0] ?? '', jobB: jobs[1] ?? '' },
      model: 'm',
    });
    await decide(user, mine.merge, forged.id, 'confirm');
    expect((await theirs.discovery.listJobs(other, {})).jobs).toHaveLength(2);
    expect(OTHER).toBeTruthy();
  });

  it('review_stats counts ai_merge items per model', async () => {
    reset();
    model = 'vendor/model-stats';
    const user = fresh();
    const { merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    await merge.run(user);
    const [item] = await pending(user);
    await decide(user, merge, item?.id ?? '', 'confirm');
    const stats = await review.stats(user);
    expect(stats.counts).toContainEqual({
      kind: 'ai_merge',
      model: 'vendor/model-stats',
      agreed: 1,
      disagreed: 0,
    });
    expect(stats.survived.map((i) => i.kind)).toEqual(['ai_merge']);
  });

  it('a runner-wide failure ends the pass after three in a row; a bad answer for one pair does not', async () => {
    reset();
    const user = fresh();
    const titles = [
      'Alpha Developer Backend Senior',
      'Alpha Developer Backend Lead',
      'Alpha Developer Backend Junior',
      'Alpha Developer Backend Staff',
    ];
    const { merge } = await setup(user, [
      posting('a'),
      ...titles.map((t, i) => posting(`t${String(i)}`, { title: t })),
    ]);
    answer = () => new AiError('auth', 'no key');
    const down = await merge.run(user);
    expect(down.calls).toBe(3);
    expect(down.errors).toHaveLength(3);
    expect(down.errors[0]).toContain('auth');
    expect(down.items).toBe(0);
    answer = () => new AiError('bad_output', 'x');
    const bad = await merge.run(user);
    expect(bad.calls).toBeGreaterThan(3); // goes on past three bad answers
  });

  it('a pass makes at most maxCallsPerPass calls and the rest wait for the next', async () => {
    reset();
    const user = fresh();
    const { discovery } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
      posting('c', { title: 'Alpha Developer Backend Lead' }),
    ]);
    const capped = createAiMerge(handle.db, { ai, review, maxCallsPerPass: 1 });
    expect(await capped.run(user)).toMatchObject({ calls: 1, items: 1 });
    expect(await capped.run(user)).toMatchObject({ calls: 1, items: 1 });
    expect((await discovery.listJobs(user, {})).jobs).toHaveLength(3);
  });

  it('two workers running at once ask each pair once', async () => {
    reset();
    const user = fresh();
    const { merge } = await setup(user, [
      posting('a'),
      posting('b', { title: 'Alpha Developer Backend Senior' }),
    ]);
    const [x, y] = await Promise.all([merge.run(user), merge.run(user)]);
    expect(x.items + y.items).toBe(1);
    expect(calls).toBe(1);
    expect(await pending(user)).toHaveLength(1);
  });
});
