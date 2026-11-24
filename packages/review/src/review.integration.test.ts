import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createReview, ReviewError, reviewMigrations, type Review } from './index';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const J = (n: number): string => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
const T1 = '00000000-0000-4000-8000-000000000401';
const T2 = '00000000-0000-4000-8000-000000000402';
const noApply = (): Promise<void> => Promise.resolve();

describe('Review items against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let review: Review;
  const rejection = (job: number, target = T1, model = 'vendor/model-a') => ({
    kind: 'ai_fit_rejection' as const,
    subject: { jobId: J(job), targetId: target },
    model,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [reviewMigrations]);
    handle = createDb(container.getConnectionUri());
    review = createReview(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('creates one pending item per user, kind and subject; a second create changes nothing', async () => {
    const first = await review.create(A, rejection(1));
    expect(first.created).toBe(true);
    const again = await review.create(A, rejection(1, T1, 'vendor/other-model'));
    expect(again).toEqual({ id: first.id, created: false });
    // Another Target, another Job, another user: separate items.
    expect((await review.create(A, rejection(1, T2))).created).toBe(true);
    expect((await review.create(A, rejection(2))).created).toBe(true);
    expect((await review.create(B, rejection(1))).created).toBe(true);
    const { items } = await review.list(A, {});
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.id === first.id)).toMatchObject({
      kind: 'ai_fit_rejection',
      model: 'vendor/model-a',
      status: 'pending',
      decidedAt: null,
      subject: { jobId: J(1), targetId: T1 },
    });
  });

  it('lists pending by default, filters by kind and status, and scopes by user', async () => {
    const a = await review.create(A, rejection(10));
    await review.create(A, {
      kind: 'ai_merge',
      subject: { jobId: J(10), otherJobId: J(11) },
      model: 'm',
    });
    expect((await review.list(A, { kind: 'ai_merge' })).items.map((i) => i.kind)).toEqual([
      'ai_merge',
    ]);
    await review.decide(A, a.id, 'confirm', noApply);
    const pending = (await review.list(A, {})).items;
    expect(pending.every((i) => i.status === 'pending')).toBe(true);
    expect(pending.some((i) => i.id === a.id)).toBe(false);
    expect((await review.list(A, { status: 'confirmed' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await review.list(B, { status: 'confirmed' })).items).toEqual([]);
  });

  it('pages by id with a cursor', async () => {
    const ids: string[] = [];
    for (const n of [20, 21, 22]) ids.push((await review.create(B, rejection(n, T2))).id);
    const first = await review.list(B, { kind: 'ai_fit_rejection', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await review.list(B, {
      kind: 'ai_fit_rejection',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.length).toBeGreaterThan(0);
    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(ids.every((id) => seen.includes(id) || second.nextCursor !== null)).toBe(true);
  });

  it('records a decision once: the applier runs with the item in the same transaction, a second decision is rejected', async () => {
    const { id } = await review.create(A, rejection(30));
    const applied: string[] = [];
    const done = await review.decide(A, id, 'disagree', (item, _tx, decision) => {
      applied.push(`${item.kind}:${decision}:${item.id}`);
      return Promise.resolve();
    });
    expect(applied).toEqual([`ai_fit_rejection:disagree:${id}`]);
    expect(done).toMatchObject({ id, status: 'disagreed' });
    expect(done.decidedAt).toBeInstanceOf(Date);
    await expect(review.decide(A, id, 'confirm', noApply)).rejects.toMatchObject({
      name: 'ReviewError',
      code: 'already_decided',
    });
    expect(applied).toHaveLength(1);
  });

  it('a failing applier rolls the decision back, so the item stays pending and can be decided again', async () => {
    const { id } = await review.create(A, rejection(31));
    await expect(
      review.decide(A, id, 'disagree', () => Promise.reject(new Error('apply failed'))),
    ).rejects.toThrow('apply failed');
    expect((await review.list(A, {})).items.find((i) => i.id === id)?.status).toBe('pending');
    expect(await review.decide(A, id, 'disagree', noApply)).toMatchObject({ status: 'disagreed' });
  });

  it('two concurrent decisions of one item: exactly one applies', async () => {
    const { id } = await review.create(A, rejection(32));
    let applies = 0;
    const apply = async (): Promise<void> => {
      applies += 1;
      await new Promise((r) => setTimeout(r, 50));
    };
    const results = await Promise.allSettled([
      review.decide(A, id, 'confirm', apply),
      review.decide(A, id, 'disagree', apply),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(applies).toBe(1);
  });

  it("another user's item is not found, and nothing of it changes", async () => {
    const { id } = await review.create(B, rejection(40));
    const err: unknown = await review.decide(A, id, 'confirm', noApply).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err).toMatchObject({ code: 'not_found' });
    expect((await review.list(B, {})).items.find((i) => i.id === id)?.status).toBe('pending');
  });

  it('stats count agreements and disagreements per kind and model, ignore pending, and list the survivors', async () => {
    const user = '00000000-0000-4000-8000-0000000000c3';
    const a = await review.create(user, rejection(50, T1, 'model-x'));
    const b = await review.create(user, rejection(51, T1, 'model-x'));
    const c = await review.create(user, rejection(52, T1, 'model-y'));
    await review.create(user, rejection(53, T1, 'model-y')); // pending
    const m = await review.create(user, {
      kind: 'ai_merge',
      subject: { jobId: J(54), otherJobId: J(55) },
      model: 'model-x',
    });
    await review.decide(user, a.id, 'confirm', noApply);
    await review.decide(user, b.id, 'disagree', noApply);
    await review.decide(user, c.id, 'confirm', noApply);
    await review.decide(user, m.id, 'disagree', noApply);
    const stats = await review.stats(user);
    expect(stats.counts).toEqual(
      expect.arrayContaining([
        { kind: 'ai_fit_rejection', model: 'model-x', agreed: 1, disagreed: 1 },
        { kind: 'ai_fit_rejection', model: 'model-y', agreed: 1, disagreed: 0 },
        { kind: 'ai_merge', model: 'model-x', agreed: 0, disagreed: 1 },
      ]),
    );
    expect(stats.counts).toHaveLength(3);
    expect(stats.survived.map((i) => i.id).sort()).toEqual([a.id, c.id].sort());
    expect(stats.survived.every((i) => i.status === 'confirmed')).toBe(true);
    expect(await review.stats(B)).not.toEqual(stats);
    expect(await review.stats('00000000-0000-4000-8000-0000000000d4')).toEqual({
      counts: [],
      survived: [],
    });
  });

  it('counts the pending items of a user', async () => {
    const user = '00000000-0000-4000-8000-0000000000e5';
    await review.create(user, rejection(60));
    await review.create(user, rejection(61));
    expect(await review.countPending(user)).toBe(2);
  });
});
