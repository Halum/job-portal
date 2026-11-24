import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import type { Ai } from '@job-portal/ai';
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

describe('new tags against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let matching: Matching;
  let targetId: string;
  const scores = new Map<string, number>([
    [J(1), 80],
    [J(2), 50],
  ]);
  const ai: Ai = {
    run: (_user, _feature, prompt, parse) => {
      const n = [1, 2].find((i) => prompt.includes(`Alpha role ${String(i)}`)) ?? 1;
      const text = JSON.stringify({
        score: scores.get(J(n)),
        reasons: [`reason ${String(n)}`],
        redFlags: [],
        languages: [],
      });
      return Promise.resolve({ value: parse(text), model: 'vendor/model', costUsd: null });
    },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [matchingMigrations]);
    handle = createDb(container.getConnectionUri());
    matching = createMatching(handle.db, {
      loadJobs: (_u, ids) =>
        Promise.resolve([job(1), job(2)].filter((j) => ids === undefined || ids.includes(j.id))),
      ai,
      defaultAlertThreshold: 70,
    });
    targetId = (
      await matching.upsertTarget(USER, { name: 'alpha', criteria: { keywords: ['alpha'] } })
    ).id;
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('lists the pairs scored since the instant that are tagged now, with score and reasons', async () => {
    const before = new Date(Date.now() - 60_000);
    await matching.score(USER);
    expect(await matching.listNewTags(USER, before)).toEqual([
      {
        jobId: J(1),
        targetId,
        targetName: 'alpha',
        score: 80,
        reasons: ['reason 1'],
        override: false,
      },
    ]);
    // Scored before the instant: not new.
    expect(await matching.listNewTags(USER, new Date(Date.now() + 60_000))).toEqual([]);
    // Another user sees nothing.
    expect(await matching.listNewTags(OTHER, before)).toEqual([]);
  });

  it('a tag override is listed whatever the instant, with the score it overrides', async () => {
    await matching.applyFitRejection(handle.db, USER, { jobId: J(2), targetId }, 'disagree');
    const tags = await matching.listNewTags(USER, new Date(Date.now() + 60_000));
    expect(tags).toEqual([
      {
        jobId: J(2),
        targetId,
        targetName: 'alpha',
        score: 50,
        reasons: ['reason 2'],
        override: true,
      },
    ]);
  });

  it('the tag is derived now: a raised threshold drops a score-only tag but not an override', async () => {
    await matching.updateGlobalDefaults(USER, { alertThreshold: 90 });
    const tags = await matching.listNewTags(USER, new Date(Date.now() - 60_000));
    expect(tags.map((t) => t.jobId)).toEqual([J(2)]);
  });
});
