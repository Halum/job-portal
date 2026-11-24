import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createMatching, matchingMigrations, type MatchableJob, type Matching } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const job = (id: string, over: Partial<MatchableJob> = {}): MatchableJob => ({
  id,
  title: 'Koch (m/w/d)',
  company: 'Beispiel Firma',
  location: 'Bamberg',
  raw: {},
  recency: new Date('2026-01-01'),
  ...over,
});
const J = (n: number): string => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

describe('matching against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let jobs: MatchableJob[] = [];
  let blocked = new Set<string>();
  let matching: Matching;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [matchingMigrations]);
    handle = createDb(container.getConnectionUri());
    matching = createMatching(handle.db, {
      // Discovery would leave out Dismissed and Expired Jobs; the fake serves what it is given.
      loadJobs: (_user, ids) =>
        Promise.resolve(jobs.filter((j) => ids === undefined || ids.includes(j.id))),
      hasApplication: (_user, ids) => Promise.resolve(new Set(ids.filter((i) => blocked.has(i)))),
      defaultPrerankTopN: 2,
    });
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('keeps Target names unique per user and updates in place', async () => {
    const a = await matching.upsertTarget(USER, { name: 'one', criteria: { keywords: ['koch'] } });
    const again = await matching.upsertTarget(USER, { name: 'one', criteria: { radiusKm: 0 } });
    const other = await matching.upsertTarget(OTHER, { name: 'one' });
    expect(again.id).toBe(a.id);
    expect(other.id).not.toBe(a.id);
    expect(again.criteria).toMatchObject({ keywords: ['koch'], radiusKm: 0 });
    expect((await matching.listTargets(USER)).map((t) => t.name)).toEqual(['one']);
    expect(await matching.listTargets(OTHER)).toHaveLength(1);
  });

  it('two edits of one Target at once both land', async () => {
    await matching.upsertTarget(USER, { name: 'race' });
    await Promise.all([
      matching.upsertTarget(USER, { name: 'race', criteria: { keywords: ['a'] } }),
      matching.upsertTarget(USER, { name: 'race', criteria: { locations: ['Bamberg'] } }),
      matching.upsertTarget(USER, { name: 'race', criteria: { radiusKm: 5 } }),
    ]);
    const race = (await matching.listTargets(USER)).find((t) => t.name === 'race');
    expect(race?.criteria).toMatchObject({ keywords: ['a'], locations: ['Bamberg'], radiusKm: 5 });
  });

  it('stores Global defaults per user, a patch keeps the other fields, null clears', async () => {
    await matching.updateGlobalDefaults(USER, { exclusionWords: ['Pflege'], alertThreshold: 0 });
    const next = await matching.updateGlobalDefaults(USER, {
      salaryFloor: 0,
      exclusionWords: null,
    });
    expect(next).toMatchObject({ exclusionWords: null, alertThreshold: 0, salaryFloor: 0 });
    expect(await matching.getGlobalDefaults(USER)).toEqual(next);
    expect((await matching.getGlobalDefaults(OTHER)).alertThreshold).toBeNull();
  });

  describe('a run over Jobs', () => {
    beforeAll(async () => {
      await matching.updateGlobalDefaults(USER, {
        exclusionWords: ['Pflege'],
        blockedCompanies: ['Blockiert'],
        keywords: null,
        alertThreshold: null,
      });
      await matching.upsertTarget(USER, {
        name: 'cooks',
        criteria: { keywords: ['koch'], locations: ['Bamberg'], radiusKm: 20, prerankTopN: 3 },
      });
      await matching.upsertTarget(USER, {
        name: 'anything nearby',
        criteria: { keywords: [], locations: ['Bamberg'], radiusKm: 0 },
      });
      await matching.upsertTarget(USER, {
        name: 'paused',
        paused: true,
        criteria: { keywords: ['koch'] },
      });
      await matching.upsertTarget(USER, { name: 'race', paused: true }); // out of the way
      await matching.upsertTarget(USER, { name: 'one', paused: true });
    });

    const target = async (name: string): Promise<string> => {
      const t = (await matching.listTargets(USER)).find((x) => x.name === name);
      if (!t) throw new Error('no target ' + name);
      return t.id;
    };

    it('applies hard filters and the prerank per Target, and records unknown places', async () => {
      jobs = [
        job(J(1)),
        job(J(2), { title: 'Koch Pflege' }), // global exclusion word
        job(J(3), { company: 'Blockiert GmbH' }), // global blocked company
        job(J(4), { location: 'Berlin' }), // outside the radius
        job(J(5), { location: 'Musterstadt' }), // unknown place: passes, flagged
        job(J(6), { title: 'Kellner' }), // no keyword hit
        job(J(7), { title: 'Webentwickler remote', location: 'Berlin' }), // remote skips the radius
      ];
      const result = await matching.run(
        USER,
        jobs.map((j) => j.id),
      );

      const cooks = (await matching.listJobIds(USER, { targetId: await target('cooks') })).sort();
      // Only titles/payload with "koch" pass: J1 and J5 (J7 and J6 have no keyword).
      expect(cooks).toEqual([J(1), J(5)]);
      const nearby = (
        await matching.listJobIds(USER, { targetId: await target('anything nearby') })
      ).sort();
      // No keywords: everything that passes the filters ties, and the Target's own top N is the default 2.
      expect(nearby).toHaveLength(2);
      expect(result.prerankPassed).toBe(cooks.length + nearby.length);
      expect(await matching.listJobIds(USER, { targetId: await target('paused') })).toEqual([]);
    });

    it('a second run over the same Jobs adds nothing new but counts the same passes', async () => {
      const before = await matching.listJobIds(USER, { targetId: await target('cooks') });
      const result = await matching.run(USER, [J(1), J(5)]);
      expect(result.prerankPassed).toBeGreaterThan(0);
      expect(await matching.listJobIds(USER, { targetId: await target('cooks') })).toEqual(before);
    });

    it('skips Jobs with an application status', async () => {
      jobs = [job(J(20)), job(J(21))];
      blocked = new Set([J(20)]);
      await matching.run(USER, [J(20), J(21)]);
      const ids = await matching.listJobIds(USER, { targetId: await target('cooks') });
      expect(ids).toContain(J(21));
      expect(ids).not.toContain(J(20));
      blocked = new Set();
    });

    it('does nothing for no Jobs and for Jobs the loader leaves out (Dismissed, Expired)', async () => {
      expect(await matching.run(USER, [])).toEqual({ prerankPassed: 0 });
      jobs = [];
      expect(await matching.run(USER, [J(30)])).toEqual({ prerankPassed: 0 });
      expect(await matching.listJobIds(USER, { targetId: await target('cooks') })).not.toContain(
        J(30),
      );
    });

    it('scopes candidates by user', async () => {
      expect(await matching.listJobIds(OTHER, { targetId: await target('cooks') })).toEqual([]);
    });
  });

  describe('searchQueries', () => {
    it('gives one search per keyword and location of each active Target and skips empty ones', async () => {
      const user = '00000000-0000-4000-8000-0000000000aa';
      await matching.updateGlobalDefaults(user, { radiusKm: 25, locations: ['Bamberg'] });
      await matching.upsertTarget(user, { name: 'a', criteria: { keywords: ['koch', 'kellner'] } });
      await matching.upsertTarget(user, {
        name: 'b',
        criteria: { keywords: ['koch'], radiusKm: 0 },
      });
      await matching.upsertTarget(user, { name: 'c', paused: true, criteria: { keywords: ['x'] } });
      expect(await matching.searchQueries(user)).toEqual([
        { was: 'koch', wo: 'Bamberg', umkreis: 25 },
        { was: 'kellner', wo: 'Bamberg', umkreis: 25 },
        { was: 'koch', wo: 'Bamberg', umkreis: 0 },
      ]);

      await matching.updateGlobalDefaults(user, { locations: null, radiusKm: null });
      await matching.upsertTarget(user, { name: 'd', criteria: {} });
      expect(await matching.searchQueries(user)).toEqual([{ was: 'koch' }, { was: 'kellner' }]);
    });

    it('is empty for a user with no Targets', async () => {
      expect(await matching.searchQueries('00000000-0000-4000-8000-0000000000bb')).toEqual([]);
    });
  });

  describe('rematch on upsert_target', () => {
    const REMATCH = '00000000-0000-4000-8000-0000000000cc';
    const ids = (targetId: string) => matching.listJobIds(REMATCH, { targetId });

    it('a Job stored before the Target existed shows up, an edit replaces, pause removes, unpause restores', async () => {
      jobs = [job(J(90), { title: 'Elektriker' }), job(J(91), { title: 'Schreiner' })];
      const made = await matching.upsertTarget(REMATCH, {
        name: 'late',
        criteria: { keywords: ['elektriker'] },
      });
      expect(await ids(made.id)).toEqual([J(90)]);

      await matching.upsertTarget(REMATCH, { name: 'late', criteria: { keywords: ['schreiner'] } });
      expect(await ids(made.id)).toEqual([J(91)]);

      await matching.upsertTarget(REMATCH, { name: 'late', paused: true });
      expect(await ids(made.id)).toEqual([]);

      await matching.upsertTarget(REMATCH, { name: 'late', paused: false });
      expect(await ids(made.id)).toEqual([J(91)]);
    });

    it('leaves the candidates of other Targets alone and skips Jobs with an application status', async () => {
      jobs = [job(J(92), { title: 'Maler' }), job(J(93), { title: 'Maler Meister' })];
      blocked = new Set([J(93)]);
      const a = await matching.upsertTarget(REMATCH, {
        name: 'a',
        criteria: { keywords: ['maler'] },
      });
      const b = await matching.upsertTarget(REMATCH, {
        name: 'b',
        criteria: { keywords: ['meister'] },
      });
      expect(await ids(a.id)).toEqual([J(92)]);
      expect(await ids(b.id)).toEqual([]);
      blocked = new Set();
      await matching.upsertTarget(REMATCH, { name: 'b', criteria: { keywords: ['maler'] } });
      expect((await ids(b.id)).sort()).toEqual([J(92), J(93)]);
      expect(await ids(a.id)).toEqual([J(92)]);
    });
  });
});
