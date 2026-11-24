import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  createDiscovery,
  discoveryMigrations,
  type PollResult,
  type Source,
} from '@job-portal/discovery';
import { createPipeline, pipelineMigrations } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

describe('pipeline against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let poll: (userId: string, sourceId: string) => Promise<PollResult>;
  const pipeline = (): ReturnType<typeof createPipeline> =>
    createPipeline(handle.db, { poll: (u, s) => poll(u, s) });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      pipelineMigrations,
      discoveryMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
  });

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  it('records a completed run with its counts', async () => {
    poll = () => Promise.resolve({ fetched: 5, newPostings: 3, jobIds: [], errors: [] });
    const run = await pipeline().execute(USER, 'src-a');
    expect(run).toMatchObject({
      sourceId: 'src-a',
      status: 'completed',
      fetched: 5,
      newPostings: 3,
      errors: [],
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(await pipeline().listRuns(USER, 10)).toContainEqual(run);
  });

  it('runs Matching over the Jobs the poll created and records the prerank count', async () => {
    poll = () => Promise.resolve({ fetched: 3, newPostings: 2, jobIds: ['j1', 'j2'], errors: [] });
    const seen: string[][] = [];
    const matched = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      {
        matching: {
          run: (_user, ids) => {
            seen.push(ids);
            return Promise.resolve({ prerankPassed: 4 });
          },
        },
      },
    );
    const run = await matched.execute(USER, 'src-m1');
    expect(seen).toEqual([['j1', 'j2']]);
    expect(run).toMatchObject({ status: 'completed', fetched: 3, prerankPassed: 4 });
    expect((await matched.listRuns(USER, 50)).find((r) => r.sourceId === 'src-m1')).toMatchObject({
      prerankPassed: 4,
    });
  });

  it('scores after matching, even when the poll found nothing new, and records the counts', async () => {
    poll = () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] });
    const scored = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      {
        scoring: {
          score: () =>
            Promise.resolve({
              scored: 3,
              tagged: 2,
              rejections: 1,
              calls: 4,
              costUsd: 0.07,
              errors: [],
            }),
        },
      },
    );
    const run = await scored.execute(USER, 'src-s1');
    expect(run).toMatchObject({
      status: 'completed',
      scored: 3,
      tagged: 2,
      aiRejections: 1,
      aiCalls: 4,
      aiCostUsd: 0.07,
    });
    expect((await scored.listRuns(USER, 50)).find((r) => r.sourceId === 'src-s1')).toMatchObject({
      scored: 3,
      aiRejections: 1,
      aiCalls: 4,
    });
  });

  it('a failed AI call ends the run completed with errors and keeps the other counts', async () => {
    poll = () => Promise.resolve({ fetched: 1, newPostings: 1, jobIds: ['j1'], errors: [] });
    const scored = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      {
        scoring: {
          score: () =>
            Promise.resolve({
              scored: 1,
              tagged: 0,
              rejections: 0,
              calls: 2,
              costUsd: 0,
              errors: ['fit score failed (rate_limit) for a Job and Target'],
            }),
        },
      },
    );
    const run = await scored.execute(USER, 'src-s2');
    expect(run).toMatchObject({
      status: 'completed_with_errors',
      fetched: 1,
      scored: 1,
      aiCalls: 2,
    });
    expect(run?.errors).toEqual(['fit score failed (rate_limit) for a Job and Target']);
  });

  it('a run whose AI calls reported no cost has an unknown cost, not 0', async () => {
    poll = () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] });
    const scored = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      {
        scoring: {
          score: () =>
            Promise.resolve({
              scored: 1,
              tagged: 0,
              rejections: 0,
              calls: 1,
              costUsd: null,
              errors: [],
            }),
        },
      },
    );
    expect(await scored.execute(USER, 'src-s4')).toMatchObject({ scored: 1, aiCostUsd: null });
    const none = createPipeline(handle.db, { poll: (u, s) => poll(u, s) });
    expect(await none.execute(USER, 'src-s5')).toMatchObject({ scored: 0, aiCostUsd: null });
  });

  it('a scoring crash is an error line, not a failed run', async () => {
    poll = () => Promise.resolve({ fetched: 2, newPostings: 1, jobIds: [], errors: [] });
    const scored = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      { scoring: { score: () => Promise.reject(new Error('db down')) } },
    );
    const run = await scored.execute(USER, 'src-s3');
    expect(run).toMatchObject({ status: 'completed_with_errors', fetched: 2, scored: 0 });
    expect(run?.errors).toEqual(['scoring failed: db down']);
  });

  it('a Matching failure is an error line: the run keeps its fetch counts and ends with errors', async () => {
    poll = () => Promise.resolve({ fetched: 3, newPostings: 2, jobIds: ['j1'], errors: [] });
    const matched = createPipeline(
      handle.db,
      { poll: (u, s) => poll(u, s) },
      { matching: { run: () => Promise.reject(new Error('boom')) } },
    );
    expect(await matched.execute(USER, 'src-m2')).toMatchObject({
      status: 'completed_with_errors',
      fetched: 3,
      newPostings: 2,
      prerankPassed: 0,
      errors: ['matching failed: boom'],
    });
  });

  it('ends "completed with errors" when the source reports errors', async () => {
    poll = () => Promise.resolve({ fetched: 2, newPostings: 1, jobIds: [], errors: ['bad entry'] });
    const run = await pipeline().execute(USER, 'src-b');
    expect(run).toMatchObject({ status: 'completed_with_errors', errors: ['bad entry'] });
  });

  const oneListing = (id: string, title: string): Source => ({
    id: 'real',
    fetch: () =>
      Promise.resolve({
        postings: [
          {
            sourcePostingId: id,
            title,
            company: 'Beispiel GmbH',
            location: 'Musterstadt',
            url: `https://jobs.example.invalid/${id}`,
            raw: {},
          },
        ],
        errors: [],
      }),
  });

  it('ends "completed with errors" when Discovery cannot store one Posting', async () => {
    const bad = oneListing('1', `Bad${String.fromCharCode(0)}title`);
    const run = await createPipeline(handle.db, createDiscovery(handle.db, [bad])).execute(
      USER,
      'real',
    );
    expect(run).toMatchObject({
      status: 'completed_with_errors',
      errors: ['posting 1 could not be stored'],
    });
  });

  it('ends "failed" when Discovery loses its database connection', async () => {
    const lost = createDb(container.getConnectionUri());
    await lost.close();
    const run = await createPipeline(
      handle.db,
      createDiscovery(lost.db, [oneListing('2', 'Koch')]),
    ).execute(USER, 'real-lost');
    expect(run?.status).toBe('failed');
  });

  it('ends "failed" with the error message when the poll throws', async () => {
    poll = () => Promise.reject(new Error('HTTP 503'));
    const run = await pipeline().execute(USER, 'src-c');
    expect(run).toMatchObject({
      status: 'failed',
      fetched: 0,
      newPostings: 0,
      errors: ['HTTP 503'],
    });
  });

  it('allows one active run per source: a second run while one is running is skipped', async () => {
    let release: () => void = () => undefined;
    poll = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ fetched: 1, newPostings: 1, jobIds: [], errors: [] });
        };
      });
    const first = pipeline().execute(USER, 'src-d');
    await new Promise((r) => setTimeout(r, 100));
    expect(await pipeline().execute(USER, 'src-d')).toBeNull();
    release();
    expect((await first)?.status).toBe('completed');
    // Once finished, the source can run again.
    poll = () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] });
    expect((await pipeline().execute(USER, 'src-d'))?.status).toBe('completed');
  });

  it("on start fails only runs older than the time bound, so another worker's live run survives", async () => {
    poll = () => new Promise(() => undefined); // never finishes: simulates a crashed worker
    void pipeline().execute(USER, 'src-e');
    await new Promise((r) => setTimeout(r, 100));

    // A second worker starting now sees a fresh run: it must not touch it.
    expect(await pipeline().failStaleRuns()).toBe(0);
    expect((await pipeline().listRuns(USER, 50)).find((r) => r.sourceId === 'src-e')?.status).toBe(
      'running',
    );

    // Once the run is older than the bound, the sweep fails it, and only it.
    const patient = createPipeline(handle.db, { poll: (u, s) => poll(u, s) }, { staleAfterMs: 50 });
    expect(await patient.failStaleRuns()).toBe(1);
    const runs = await pipeline().listRuns(USER, 50);
    const stale = runs.find((r) => r.sourceId === 'src-e');
    expect(stale).toMatchObject({
      status: 'failed',
      errors: ['run did not finish within the time bound'],
    });
    expect(stale?.finishedAt).toBeInstanceOf(Date);
    expect(runs.find((r) => r.sourceId === 'src-a')?.status).toBe('completed');
    // The source is free again.
    poll = () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] });
    expect((await pipeline().execute(USER, 'src-e'))?.status).toBe('completed');
  });

  it('recovers a source whose run never finished: the next tick fails the old run after the bound', async () => {
    poll = () => new Promise(() => undefined); // a run that never finishes and is never marked
    void pipeline().execute(USER, 'src-f');
    await new Promise((r) => setTimeout(r, 100));
    expect(await pipeline().execute(USER, 'src-f')).toBeNull(); // within the bound it still blocks

    poll = () => Promise.resolve({ fetched: 1, newPostings: 1, jobIds: [], errors: [] });
    const patient = createPipeline(handle.db, { poll: (u, s) => poll(u, s) }, { staleAfterMs: 50 });
    expect((await patient.execute(USER, 'src-f'))?.status).toBe('completed');
    const runs = (await patient.listRuns(USER, 50)).filter((r) => r.sourceId === 'src-f');
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
    expect(runs.find((r) => r.status === 'failed')?.errors).toEqual([
      'run did not finish within the time bound',
    ]);
  });

  it('a run failed as lost cannot later overwrite its failed row when it finishes', async () => {
    let release: () => void = () => undefined;
    poll = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ fetched: 9, newPostings: 9, jobIds: [], errors: [] });
        };
      });
    const slow = pipeline().execute(USER, 'src-g');
    await new Promise((r) => setTimeout(r, 100));

    const patient = createPipeline(
      handle.db,
      { poll: () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] }) },
      { staleAfterMs: 50 },
    );
    expect((await patient.execute(USER, 'src-g'))?.status).toBe('completed');

    release(); // the old run finishes late
    expect((await slow)?.status).toBe('failed');
    const runs = (await pipeline().listRuns(USER, 50)).filter((r) => r.sourceId === 'src-g');
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
    expect(runs.find((r) => r.status === 'failed')).toMatchObject({ fetched: 0, newPostings: 0 });
  });

  it('lists the newest runs first, limited, scoped to the user', async () => {
    const runs = await pipeline().listRuns(USER, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.startedAt.getTime()).toBeGreaterThanOrEqual(runs[1]?.startedAt.getTime() ?? 0);
    expect(await pipeline().listRuns(OTHER_USER, 10)).toEqual([]);
  });

  describe('Notifications after a run', () => {
    interface Report {
      since: Date;
      failing: string[];
      checked: string[];
    }
    const withNotifications = (
      sink: Report[],
      scoring?: { calls: number; errors: string[] },
      afterRun: () => Promise<void> = () => Promise.resolve(),
    ): ReturnType<typeof createPipeline> =>
      createPipeline(
        handle.db,
        { poll: (u, s) => poll(u, s) },
        {
          notifications: {
            afterRun: async (_user, report) => {
              sink.push(report);
              await afterRun();
              return { digestSent: false, alertsSent: 0, unsent: 0 };
            },
          },
          aiRunnerName: 'openrouter',
          ...(scoring
            ? {
                scoring: {
                  score: () =>
                    Promise.resolve({
                      scored: 0,
                      tagged: 0,
                      rejections: 0,
                      calls: scoring.calls,
                      costUsd: null,
                      errors: scoring.errors,
                    }),
                },
              }
            : {}),
        },
      );

    it('reports a clean run as checked with nothing failing, with the run start as the instant', async () => {
      poll = () => Promise.resolve({ fetched: 0, newPostings: 0, jobIds: [], errors: [] });
      const reports: Report[] = [];
      const run = await withNotifications(reports).execute(USER, 'src-n1');
      expect(reports).toEqual([
        { since: run?.startedAt, failing: [], checked: ['source:src-n1', 'board:src-n1:'] },
      ]);
    });

    it('turns board lines and AI error classes into failure types, and checks the AI types only when calls were made', async () => {
      poll = () =>
        Promise.resolve({
          fetched: 0,
          newPostings: 0,
          jobIds: [],
          errors: ['src-n2 board acme: HTTP 404', 'src-n2 board beta-co: HTTP 500'],
        });
      const reports: Report[] = [];
      await withNotifications(reports, {
        calls: 2,
        errors: [
          'fit score failed (rate_limit) for a Job and Target',
          'fit score failed (rate_limit) for a Job and Target',
          'fit score failed (bad_output) for a Job and Target',
        ],
      }).execute(USER, 'src-n2');
      expect(reports[0]?.failing.sort()).toEqual([
        'ai:openrouter:bad_output',
        'ai:openrouter:rate_limit',
        'board:src-n2:acme',
        'board:src-n2:beta-co',
      ]);
      expect(reports[0]?.checked).toEqual(['source:src-n2', 'board:src-n2:', 'ai:']);

      const idle: Report[] = [];
      await withNotifications(idle, { calls: 0, errors: [] }).execute(USER, 'src-n2b');
      expect(idle[0]?.checked).toEqual(['source:src-n2b', 'board:src-n2b:']);
    });

    it('a failed run is a failing source and checks nothing else, since boards and the runner were not reached', async () => {
      poll = () => Promise.reject(new Error('source is down'));
      const reports: Report[] = [];
      const run = await withNotifications(reports).execute(USER, 'src-n3');
      expect(run?.status).toBe('failed');
      expect(reports[0]).toMatchObject({
        failing: ['source:src-n3'],
        checked: ['source:src-n3'],
      });
    });

    it('a Notifications crash is an error line, not a failed run', async () => {
      poll = () => Promise.resolve({ fetched: 1, newPostings: 0, jobIds: [], errors: [] });
      const run = await withNotifications([], undefined, () =>
        Promise.reject(new Error('db went away')),
      ).execute(USER, 'src-n4');
      expect(run).toMatchObject({ status: 'completed_with_errors', fetched: 1 });
      expect(run?.errors).toEqual(['notifications failed: db went away']);
    });

    it('without Notifications nothing changes', async () => {
      poll = () => Promise.resolve({ fetched: 1, newPostings: 0, jobIds: [], errors: [] });
      expect((await pipeline().execute(USER, 'src-n5'))?.status).toBe('completed');
    });
  });
});
