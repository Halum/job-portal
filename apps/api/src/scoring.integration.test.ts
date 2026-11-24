import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import { AiError, createAi, createAiLog, type AiRunner } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { createMatching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

// Fit scores through MCP: the AI runner is faked, everything else is real.
describe('fit scores over MCP', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;
  let fail = false;
  /** Text that makes the fake runner score a posting high. */
  let strong = 'Strong';
  const runner: AiRunner = {
    name: 'openrouter',
    model: 'vendor/model',
    complete: (prompt) => {
      if (fail) return Promise.reject(new AiError('rate_limit', 'slow down'));
      const score = prompt.includes(strong) ? 88 : 41;
      return Promise.resolve({
        text: JSON.stringify({ score, reasons: ['fits'], redFlags: ['far'], languages: [] }),
        model: 'vendor/model',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.002,
      });
    },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    // An idle source stands in for a poll that finds nothing new.
    const discovery = createDiscovery(handle.db, [
      { id: 'idle', fetch: () => Promise.resolve({ postings: [], errors: [] }) },
    ]);
    const tracker = createTracker(handle.db, discovery);
    const aiLog = createAiLog(handle.db);
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
      ai: createAi(aiLog, runner),
    });
    const pipeline = createPipeline(handle.db, discovery, { matching, scoring: matching });
    server = createApiServer({
      review: createReview(handle.db),
      accounts,
      discovery,
      matching,
      pipeline,
      tracker,
      aiLog,
      boards: {
        watchlist: createWatchlist(handle.db),
        fetch: () => Promise.reject(new Error('no network in tests')),
        allowAddBoard: () => Promise.resolve(true),
      },
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`);
    // The pipeline needs a source to run; scoring is driven through a Run with no sources polled.
    pipelineRef = pipeline;
  });
  let pipelineRef: ReturnType<typeof createPipeline>;

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    try {
      const res = await client.callTool({ name, arguments: args });
      return {
        isError: res.isError === true,
        out: res.structuredContent as never,
        text: JSON.stringify(res.content),
      };
    } finally {
      await client.close();
    }
  };

  let strongId = '';
  let weakId = '';
  let targetId = '';

  it('scores candidates in a run and shows scores, tags and the unknown-location flag in get_job', async () => {
    strongId = (
      (
        await call('add_job', {
          title: 'Strong alpha role',
          url: 'https://example.invalid/1',
          city: 'Atlantis',
        })
      ).out as { jobId: string }
    ).jobId;
    weakId = (
      (await call('add_job', { title: 'Weak alpha role', url: 'https://example.invalid/2' }))
        .out as { jobId: string }
    ).jobId;
    const target = (
      await call('upsert_target', {
        name: 'alpha',
        criteria: { keywords: ['alpha'], locations: ['Köln'], radiusKm: 10, alertThreshold: 60 },
      })
    ).out as { target: { id: string } };
    targetId = target.target.id;
    // A run with nothing new to poll still scores the candidates: any run retries unscored pairs.
    const run = await pipelineRef.execute(userId, 'idle');
    expect(run).toMatchObject({ status: 'completed', scored: 2, tagged: 1, aiCalls: 2 });

    const strong = (await call('get_job', { jobId: strongId })).out as {
      job: { scores: Record<string, unknown>[] };
    };
    expect(strong.job.scores).toEqual([
      expect.objectContaining({
        targetId,
        targetName: 'alpha',
        score: 88,
        tagged: true,
        reasons: ['fits'],
        redFlags: ['far'],
        unknownLocation: true,
      }),
    ]);
    const weak = (await call('get_job', { jobId: weakId })).out as {
      job: { scores: { score: number; tagged: boolean }[] };
    };
    expect(weak.job.scores[0]).toMatchObject({ score: 41, tagged: false });
  });

  it('list_jobs filters by minimum score per Target before paging', async () => {
    const ids = async (args: Record<string, unknown>): Promise<string[]> =>
      ((await call('list_jobs', args)).out as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(await ids({ targetId, minScore: 80 })).toEqual([strongId]);
    expect((await ids({ targetId, minScore: 0 })).sort()).toEqual([strongId, weakId].sort());
    expect(await ids({ targetId, minScore: 90 })).toEqual([]);
    // Filters apply before the page: a page of one still holds the one Job that passes.
    expect(await ids({ targetId, minScore: 80, limit: 1 })).toEqual([strongId]);
    // The tag follows the threshold now (60 for this Target): 88 is tagged, 41 is not.
    expect(await ids({ targetId, tagged: true })).toEqual([strongId]);
    expect(await ids({ targetId, tagged: false })).toEqual([weakId]);
    const lowered = await call('upsert_target', {
      name: 'alpha',
      criteria: { alertThreshold: 40 },
    });
    expect(lowered.isError).toBe(false);
    expect((await ids({ targetId, tagged: true })).sort()).toEqual([strongId, weakId].sort());
    const weakTag = (await call('get_job', { jobId: weakId })).out as {
      job: { scores: { tagged: boolean }[] };
    };
    expect(weakTag.job.scores[0]?.tagged).toBe(true);
    await call('upsert_target', { name: 'alpha', criteria: { alertThreshold: 60 } });
    expect((await call('list_jobs', { tagged: true })).isError).toBe(true);
    const refused = await call('list_jobs', { minScore: 50 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('targetId');
    expect((await call('list_jobs', { targetId, minScore: 101 })).isError).toBe(true);
  });

  it('get_run_history shows the AI counts of each run and the totals of the call log', async () => {
    const { runs, aiTotals } = (await call('get_run_history')).out as {
      runs: { scored: number; tagged: number; aiCalls: number; aiCostUsd: number }[];
      aiTotals: Record<string, number>;
    };
    expect(runs[0]).toMatchObject({ scored: 2, tagged: 1, aiCalls: 2 });
    expect(runs[0]?.aiCostUsd).toBeCloseTo(0.004);
    expect(aiTotals).toMatchObject({ calls: 2, failures: 0, inputTokens: 200, outputTokens: 40 });
    expect(aiTotals.costUsd).toBeCloseTo(0.004);
  });

  it('a failed call leaves the Job unscored in get_job, ends the run with errors, and the next run retries it', async () => {
    const third = (
      (await call('add_job', { title: 'Strong alpha again', url: 'https://example.invalid/3' }))
        .out as { jobId: string }
    ).jobId;
    await call('upsert_target', { name: 'alpha', criteria: { radiusKm: 11 } }); // rematch picks up the new Job
    fail = true;
    const run = await pipelineRef.execute(userId, 'idle');
    expect(run).toMatchObject({ status: 'completed_with_errors', scored: 0, aiCalls: 1 });
    expect(run?.errors[0]).toContain('rate_limit');
    const unscored = (await call('get_job', { jobId: third })).out as {
      job: { scores: { score: number | null; tagged: boolean }[] };
    };
    expect(unscored.job.scores[0]).toMatchObject({ score: null, tagged: false });
    const { aiTotals } = (await call('get_run_history')).out as {
      aiTotals: { failures: number; calls: number };
    };
    expect(aiTotals).toMatchObject({ calls: 3, failures: 1 });

    fail = false;
    const retry = await pipelineRef.execute(userId, 'idle');
    expect(retry).toMatchObject({ status: 'completed', scored: 1, tagged: 1 });
    const scored = (await call('get_job', { jobId: third })).out as {
      job: { scores: { score: number | null }[] };
    };
    expect(scored.job.scores[0]?.score).toBe(88);
  });

  it('list_jobs applies the score filter before the page: a page of one holds the Job that passes even when it sorts last', async () => {
    const made = await Promise.all(
      ['one', 'two', 'three'].map(async (n, i) => ({
        title: `Beta ${n} role`,
        id: (
          (
            await call('add_job', {
              title: `Beta ${n} role`,
              url: `https://example.invalid/b${String(i)}`,
            })
          ).out as { jobId: string }
        ).jobId,
      })),
    );
    const last = [...made].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
    strong = last?.title ?? '';
    const beta = (await call('upsert_target', { name: 'beta', criteria: { keywords: ['beta'] } }))
      .out as {
      target: { id: string };
    };
    await pipelineRef.execute(userId, 'idle');
    const page = (await call('list_jobs', { targetId: beta.target.id, minScore: 80, limit: 1 }))
      .out as {
      jobs: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.jobs.map((j) => j.id)).toEqual([last?.id]);
    expect(page.nextCursor).toBeNull();
    strong = 'Strong';
  });
});
