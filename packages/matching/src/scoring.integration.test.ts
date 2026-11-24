import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { AiError, type Ai } from '@job-portal/ai';
import { createMatching, matchingMigrations, type MatchableJob, type Matching } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const J = (n: number): string => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const job = (n: number, over: Partial<MatchableJob> = {}): MatchableJob => ({
  id: J(n),
  title: `Alpha role ${String(n)}`,
  company: 'Beispiel Firma',
  location: 'Köln',
  raw: {},
  recency: new Date(2026, 0, n),
  ...over,
});
const answer = (score: number, languages: unknown[] = []): string =>
  JSON.stringify({ score, reasons: ['r'], redFlags: [], languages });

describe('fit scoring against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let jobs: MatchableJob[] = [];
  let prompts: string[] = [];
  let respond: (prompt: string) => Promise<string> | string;
  let cost: number | null = 0.01;

  const ai: Ai = {
    async run(_user, _feature, prompt, parse) {
      prompts.push(prompt);
      const text = await respond(prompt);
      return { value: parse(text), costUsd: cost };
    },
  };
  const make = (deps: { ai?: Ai | null } = {}): Matching =>
    createMatching(handle.db, {
      loadJobs: (_u, ids) =>
        Promise.resolve(jobs.filter((j) => ids === undefined || ids.includes(j.id))),
      ...(deps.ai === null ? {} : { ai: deps.ai ?? ai }),
      defaultAlertThreshold: 70,
    });
  let matching: Matching;
  let n = 0;
  /** A fresh Target (so tests do not share candidates) over the current jobs. */
  const target = async (criteria: object = {}): Promise<string> => {
    n += 1;
    return (
      await matching.upsertTarget(USER, {
        name: `t${String(n)}`,
        criteria: { keywords: ['alpha'], ...criteria },
      })
    ).id;
  };
  const scoreOf = async (jobId: string, targetId: string) =>
    (await matching.listScores(USER, jobId)).find((s) => s.targetId === targetId);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [matchingMigrations]);
    handle = createDb(container.getConnectionUri());
    matching = make();
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const reset = (): void => {
    prompts = [];
    cost = 0.01;
    respond = () => answer(80);
  };

  it('scores each candidate of a Target, tags at or above the threshold and keeps the rest as a stored score', async () => {
    reset();
    jobs = [job(1), job(2)];
    respond = (p) => (p.includes('Alpha role 1') ? answer(70) : answer(69));
    const id = await target();
    const result = await matching.score(USER);
    expect(result).toMatchObject({ scored: 2, tagged: 1, calls: 2, errors: [] });
    expect(result.costUsd).toBeCloseTo(0.02);
    expect(await scoreOf(J(1), id)).toMatchObject({
      score: 70,
      tagged: true,
      reasons: ['r'],
      redFlags: [],
    });
    expect(await scoreOf(J(2), id)).toMatchObject({ score: 69, tagged: false });
    // Scored pairs are not scored again.
    prompts = [];
    expect(await matching.score(USER)).toMatchObject({ scored: 0, calls: 0 });
    expect(prompts).toEqual([]);
  });

  it('the Target threshold, then the Global default, then the configured default decides the tag; 0 is a real threshold', async () => {
    reset();
    jobs = [job(3)];
    respond = () => answer(10);
    const strict = await target({ alertThreshold: 11 });
    const zero = await target({ alertThreshold: 0 });
    await matching.score(USER);
    expect((await scoreOf(J(3), strict))?.tagged).toBe(false);
    expect((await scoreOf(J(3), zero))?.tagged).toBe(true);
    await matching.updateGlobalDefaults(USER, { alertThreshold: 5 });
    const inherits = await target();
    await matching.score(USER);
    expect((await scoreOf(J(3), inherits))?.tagged).toBe(true);
    await matching.updateGlobalDefaults(USER, { alertThreshold: null });
  });

  it('judges the extracted language requirement in code against the Target ability', async () => {
    reset();
    jobs = [job(4)];
    respond = () =>
      answer(95, [
        { language: 'de', required: 'required', level: 'B2', phrase: 'fliessend Deutsch' },
      ]);
    const cannot = await target({ languageAbility: ['de:A2'] });
    const can = await target({ languageAbility: ['de:C1'] });
    const unknown = await target();
    await matching.score(USER);
    expect(await scoreOf(J(4), cannot)).toMatchObject({
      score: 20,
      tagged: false,
      languageMet: false,
    });
    expect((await scoreOf(J(4), cannot))?.redFlags.join(' ')).toContain('de:B2');
    expect(await scoreOf(J(4), can)).toMatchObject({ score: 95, tagged: true, languageMet: true });
    expect(await scoreOf(J(4), unknown)).toMatchObject({ score: 95, languageMet: null });
    expect((await scoreOf(J(4), cannot))?.languages).toEqual([
      { language: 'de', required: 'required', level: 'B2', phrase: 'fliessend Deutsch' },
    ]);
  });

  it('a failed call leaves the pair unscored, is an error line with its class, and the next pass retries it', async () => {
    reset();
    jobs = [job(5), job(6)];
    const id = await target();
    respond = (p) => {
      if (p.includes('Alpha role 5')) throw new AiError('rate_limit', 'slow down');
      return answer(90);
    };
    const first = await matching.score(USER);
    expect(first).toMatchObject({ scored: 1, tagged: 1, calls: 2 });
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain('rate_limit');
    expect((await scoreOf(J(5), id))?.score).toBeNull();
    expect((await scoreOf(J(6), id))?.score).toBe(90);
    respond = () => answer(55);
    expect(await matching.score(USER)).toMatchObject({ scored: 1, errors: [] });
    expect((await scoreOf(J(5), id))?.score).toBe(55);
  });

  it('scores the oldest candidate first', async () => {
    reset();
    jobs = [job(7)];
    await target();
    // Candidates made by one statement share a time; a later run makes a newer one.
    jobs = [job(7), job(8)];
    await matching.run(USER, [J(8)]);
    await matching.score(USER);
    expect(prompts[0]).toContain('Alpha role 7');
    expect(prompts[1]).toContain('Alpha role 8');
  });

  it('stops a pass after three failures in a row so a dead runner does not burn calls', async () => {
    reset();
    jobs = [job(10), job(11), job(12), job(13), job(14)];
    await target({ keywords: ['alpha'], locations: null });
    respond = () => {
      throw new AiError('auth', 'bad key');
    };
    // Earlier tests left other candidates unscored? No: every earlier pair is scored.
    const result = await matching.score(USER);
    expect(result.calls).toBe(3);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.join(' ')).toContain('auth');
    reset();
    expect(await matching.score(USER)).toMatchObject({ errors: [] });
  });

  it('an unparseable answer counts as a failure too', async () => {
    reset();
    jobs = [job(15)];
    const id = await target();
    respond = () => 'not json';
    const result = await matching.score(USER);
    expect(result.scored).toBe(0);
    expect((await scoreOf(J(15), id))?.score).toBeNull();
    reset();
    await matching.score(USER);
  });

  it('two workers never score the same pair twice at once', async () => {
    reset();
    jobs = [job(20), job(21), job(22), job(23), job(24), job(25)];
    await target();
    respond = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return answer(75);
    };
    const [a, b] = await Promise.all([make().score(USER), make().score(USER)]);
    expect(a.scored + b.scored).toBe(6);
    expect(prompts).toHaveLength(6);
    expect(new Set(prompts).size).toBe(6);
  });

  it('skips paused Targets and Jobs that Matching may no longer look at', async () => {
    reset();
    jobs = [job(30), job(31)];
    const paused = await target();
    await matching.upsertTarget(USER, { name: `t${String(n)}`, paused: true });
    await matching.score(USER); // scores the pair for the Target above? it is paused, so no
    expect(prompts).toEqual([]);
    await matching.upsertTarget(USER, { name: `t${String(n)}`, paused: false });
    jobs = [job(31)]; // 30 is Dismissed: Discovery no longer serves it
    const result = await matching.score(USER);
    expect(result.calls).toBe(1);
    expect(await scoreOf(J(30), paused)).toMatchObject({ score: null });
  });

  it('keeps scores when a Target is edited and its candidates are replaced, and never scores them again', async () => {
    reset();
    jobs = [job(40)];
    const id = await target();
    await matching.score(USER);
    await matching.upsertTarget(USER, { name: `t${String(n)}`, criteria: { radiusKm: 50 } });
    prompts = [];
    await matching.score(USER);
    expect(prompts).toEqual([]);
    expect((await scoreOf(J(40), id))?.score).toBe(80);
  });

  it('shows per-Target scores with the unknown-location flag, and filters ids by minimum score', async () => {
    reset();
    jobs = [job(50, { location: 'Atlantis' }), job(51)];
    respond = (p) => (p.includes('role 50') ? answer(90) : answer(40));
    const id = await target({ locations: ['Köln'], radiusKm: 10 });
    await matching.score(USER);
    const forJob = (await matching.listScores(USER, J(50))).find((s) => s.targetId === id);
    expect(forJob).toMatchObject({ score: 90, tagged: true, unknownLocation: true });
    expect((await matching.listScores(USER, J(51))).find((s) => s.targetId === id)).toMatchObject({
      unknownLocation: false,
    });
    expect(await matching.listJobIds(USER, { targetId: id, minScore: 90 })).toEqual([J(50)]);
    expect((await matching.listJobIds(USER, { targetId: id, minScore: 0 })).sort()).toEqual([
      J(50),
      J(51),
    ]);
    expect(await matching.listJobIds(USER, { targetId: id, minScore: 91 })).toEqual([]);
    expect((await matching.listJobIds(USER, { targetId: id })).sort()).toEqual([J(50), J(51)]);
  });

  it('with no AI configured nothing is scored', async () => {
    reset();
    jobs = [job(60)];
    const plain = make({ ai: null });
    await target();
    expect(await plain.score(USER)).toEqual({
      scored: 0,
      tagged: 0,
      calls: 0,
      costUsd: 0,
      errors: [],
    });
  });

  it('a call that reports no cost adds nothing to the cost', async () => {
    reset();
    cost = null;
    jobs = [job(61)];
    await target();
    expect((await matching.score(USER)).costUsd).toBe(0);
  });
});
