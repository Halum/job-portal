import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import type { Ai } from '@job-portal/ai';
import { createReview, reviewMigrations, type Review, type ReviewTx } from '@job-portal/review';
import { createMatching, matchingMigrations, type MatchableJob, type Matching } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const J = (n: number): string => `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`;
const job = (n: number): MatchableJob => ({
  id: J(n),
  title: `Alpha role ${String(n)}`,
  company: 'Beispiel Firma',
  location: 'Köln',
  raw: {},
  recency: new Date(2026, 0, n),
});

describe('AI fit rejections become Review items', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let review: Review;
  let matching: Matching;
  let jobs: MatchableJob[] = [];
  let scoreFor: (prompt: string) => number = () => 50;
  let model = 'vendor/model-a';
  let n = 0;

  const ai: Ai = {
    run(_user, _feature, prompt, parse) {
      const text = JSON.stringify({
        score: scoreFor(prompt),
        reasons: ['r'],
        redFlags: [],
        languages: [],
      });
      return Promise.resolve({ value: parse(text), model, costUsd: null });
    },
  };
  const target = async (criteria: object = {}): Promise<string> => {
    n += 1;
    return (
      await matching.upsertTarget(USER, {
        name: `t${String(n)}`,
        criteria: { keywords: ['alpha'], ...criteria },
      })
    ).id;
  };
  const pending = async (userId = USER) => (await review.list(userId, { limit: 200 })).items;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      matchingMigrations,
      reviewMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    review = createReview(handle.db);
    matching = createMatching(handle.db, {
      loadJobs: (_u, ids) =>
        Promise.resolve(jobs.filter((j) => ids === undefined || ids.includes(j.id))),
      ai,
      review,
      defaultAlertThreshold: 70,
    });
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('a score below the threshold raises one item for the Job and Target with the model; at or above raises none', async () => {
    jobs = [job(1), job(2)];
    scoreFor = (p) => (p.includes('Alpha role 1') ? 69 : 70);
    model = 'vendor/model-a';
    const id = await target();
    const result = await matching.score(USER);
    expect(result).toMatchObject({ scored: 2, tagged: 1, rejections: 1 });
    const items = (await pending()).filter((i) => i.subject.targetId === id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'ai_fit_rejection',
      model: 'vendor/model-a',
      status: 'pending',
      subject: { jobId: J(1), targetId: id },
    });
  });

  it('a Target threshold of 0 never rejects, and the Global default applies to a Target that sets none', async () => {
    jobs = [job(3)];
    scoreFor = () => 10;
    const zero = await target({ alertThreshold: 0 });
    await matching.score(USER);
    expect((await pending()).filter((i) => i.subject.targetId === zero)).toEqual([]);
    await matching.updateGlobalDefaults(USER, { alertThreshold: 20 });
    const inherits = await target();
    await matching.score(USER);
    expect((await pending()).filter((i) => i.subject.targetId === inherits)).toHaveLength(1);
    await matching.updateGlobalDefaults(USER, { alertThreshold: null });
  });

  it('scoring again, or editing criteria, never duplicates an item', async () => {
    jobs = [job(4)];
    scoreFor = () => 5;
    const id = await target();
    await matching.score(USER);
    await matching.score(USER);
    await matching.upsertTarget(USER, {
      name: `t${String(n)}`,
      criteria: { keywords: ['alpha', 'beta'] },
    });
    expect(await matching.score(USER)).toMatchObject({ rejections: 0 });
    expect((await pending()).filter((i) => i.subject.targetId === id)).toHaveLength(1);
  });

  it('a failed call raises nothing', async () => {
    const failing = createMatching(handle.db, {
      loadJobs: (_u, ids) =>
        Promise.resolve(jobs.filter((j) => ids === undefined || ids.includes(j.id))),
      ai: { run: () => Promise.reject(new Error('boom')) },
      review,
    });
    jobs = [job(5)];
    const id = await target();
    expect(await failing.score(USER)).toMatchObject({ scored: 0, rejections: 0 });
    expect((await pending()).filter((i) => i.subject.targetId === id)).toEqual([]);
  });

  describe('applying a decided item', () => {
    const rejected = async (num: number) => {
      jobs = [job(num)];
      scoreFor = () => 30;
      const id = await target();
      await matching.score(USER);
      const item = (await pending()).find((i) => i.subject.targetId === id);
      if (!item) throw new Error('no item');
      return { id, item };
    };
    const tx = (fn: (t: ReviewTx) => Promise<void>): Promise<void> => handle.db.transaction(fn);

    it('a disagreement tags the Job with the Target at once, in listScores and in list_jobs filters; a confirmation changes nothing', async () => {
      const a = await rejected(10);
      const b = await rejected(11);
      expect((await matching.listScores(USER, J(10)))[0]?.tagged).toBe(false);
      await tx((t) => matching.applyFitRejection(t, USER, a.item.subject, 'disagree'));
      await tx((t) => matching.applyFitRejection(t, USER, b.item.subject, 'confirm'));
      expect((await matching.listScores(USER, J(10)))[0]).toMatchObject({
        score: 30,
        tagged: true,
      });
      expect((await matching.listScores(USER, J(11)))[0]).toMatchObject({
        score: 30,
        tagged: false,
      });
      expect(await matching.listJobIds(USER, { targetId: a.id, tagged: true })).toEqual([J(10)]);
      expect(await matching.listJobIds(USER, { targetId: a.id, tagged: false })).toEqual([]);
      expect(await matching.listJobIds(USER, { targetId: b.id, tagged: false })).toEqual([J(11)]);
    });

    it('applying twice is harmless, and a score is not a prerequisite for a later threshold edit to keep the override', async () => {
      const a = await rejected(12);
      await tx((t) => matching.applyFitRejection(t, USER, a.item.subject, 'disagree'));
      await tx((t) => matching.applyFitRejection(t, USER, a.item.subject, 'disagree'));
      await matching.upsertTarget(USER, {
        name: `t${String(n)}`,
        criteria: { alertThreshold: 90 },
      });
      expect((await matching.listScores(USER, J(12)))[0]?.tagged).toBe(true);
    });

    it("refuses another user's item, so it never tags", async () => {
      const a = await rejected(13);
      await expect(
        tx((t) => matching.applyFitRejection(t, OTHER, a.item.subject, 'disagree')),
      ).rejects.toThrow(/not the user/);
      expect((await matching.listScores(USER, J(13)))[0]?.tagged).toBe(false);
    });

    it('refuses a subject that is not a Job and Target pair', async () => {
      await expect(
        tx((t) => matching.applyFitRejection(t, USER, { jobId: 'nope' }, 'disagree')),
      ).rejects.toThrow();
    });
  });
});
