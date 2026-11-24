import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import { createAi, createAiLog, type AiRunner } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { createMatching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createReview, type Review } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

interface ReviewOut {
  id: string;
  kind: string;
  status: string;
  model: string;
  postings: { url: string; title: string }[];
  target: { id: string; name: string } | null;
  score: number | null;
  reasons: string[];
  redFlags: string[];
}

// The Review queue through MCP: the AI runner is faked, everything else is real.
describe('Review queue over MCP', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;
  let review: Review;
  let pipelineRef: ReturnType<typeof createPipeline>;
  const runner: AiRunner = {
    name: 'openrouter',
    model: 'vendor/model',
    complete: (prompt) =>
      Promise.resolve({
        text: JSON.stringify({
          score: prompt.includes('Strong') ? 88 : 41,
          reasons: ['fits'],
          redFlags: ['far'],
          languages: [],
        }),
        model: 'vendor/model-routed',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.002,
      }),
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    const discovery = createDiscovery(handle.db, [
      { id: 'idle', fetch: () => Promise.resolve({ postings: [], errors: [] }) },
    ]);
    const tracker = createTracker(handle.db, discovery);
    const aiLog = createAiLog(handle.db);
    review = createReview(handle.db);
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
      ai: createAi(aiLog, runner),
      review,
    });
    pipelineRef = createPipeline(handle.db, discovery, { matching, scoring: matching });
    server = createApiServer({
      accounts,
      discovery,
      matching,
      pipeline: pipelineRef,
      tracker,
      review,
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
  });
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
  const addJob = async (title: string, n: number): Promise<string> =>
    (
      (await call('add_job', { title, url: `https://example.invalid/r${String(n)}` })).out as {
        jobId: string;
      }
    ).jobId;
  const pending = async (args: Record<string, unknown> = {}): Promise<ReviewOut[]> =>
    ((await call('list_reviews', args)).out as { items: ReviewOut[] }).items;

  let strongId = '';
  let weakOne = '';
  let weakTwo = '';
  let targetId = '';

  it('a run raises one Review item per rejected pair, counted on the Run, listed with links, Target, score and reasons', async () => {
    strongId = await addJob('Strong alpha role', 1);
    weakOne = await addJob('Weak alpha one', 2);
    weakTwo = await addJob('Weak alpha two', 3);
    targetId = (
      (
        await call('upsert_target', {
          name: 'alpha',
          criteria: { keywords: ['alpha'], alertThreshold: 60 },
        })
      ).out as { target: { id: string } }
    ).target.id;
    const run = await pipelineRef.execute(userId, 'idle');
    expect(run).toMatchObject({ status: 'completed', scored: 3, tagged: 1, aiRejections: 2 });

    const items = await pending();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.postings[0]?.url).sort()).toEqual([
      'https://example.invalid/r2',
      'https://example.invalid/r3',
    ]);
    expect(items[0]).toMatchObject({
      kind: 'ai_fit_rejection',
      status: 'pending',
      model: 'vendor/model-routed',
      target: { id: targetId, name: 'alpha' },
      score: 41,
      reasons: ['fits'],
      redFlags: ['far'],
    });
    expect(await pending({ kind: 'ai_merge' })).toEqual([]);
    // A second run raises nothing new.
    expect(await pipelineRef.execute(userId, 'idle')).toMatchObject({ aiRejections: 0 });
    expect(await pending()).toHaveLength(2);
    const history = (await call('get_run_history')).out as { runs: { aiRejections: number }[] };
    expect(history.runs.map((r) => r.aiRejections)).toEqual([0, 2]);
  });

  it('disagreeing tags the Job with the Target; confirming leaves it untagged; a second decision is refused', async () => {
    const byJob = async (title: string): Promise<ReviewOut> => {
      const found = (await pending()).find((i) => i.postings[0]?.title === title);
      if (!found) throw new Error('no item for ' + title);
      return found;
    };
    const one = await byJob('Weak alpha one');
    const two = await byJob('Weak alpha two');
    const ids = async (tagged: boolean): Promise<string[]> =>
      ((await call('list_jobs', { targetId, tagged })).out as { jobs: { id: string }[] }).jobs
        .map((j) => j.id)
        .sort();

    const done = await call('decide_review', { id: one.id, decision: 'disagree' });
    expect(done.out).toMatchObject({ item: { id: one.id, status: 'disagreed' } });
    expect(await ids(true)).toEqual([strongId, weakOne].sort());
    const job = (await call('get_job', { jobId: weakOne })).out as {
      job: { scores: { tagged: boolean; score: number }[] };
    };
    expect(job.job.scores[0]).toMatchObject({ tagged: true, score: 41 });

    await call('decide_review', { id: two.id, decision: 'confirm' });
    expect(await ids(false)).toEqual([weakTwo]);

    const again = await call('decide_review', { id: one.id, decision: 'confirm' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already decided');
    expect(await pending()).toEqual([]);
    expect(
      (await call('decide_review', { id: crypto.randomUUID(), decision: 'confirm' })).isError,
    ).toBe(true);
  });

  it('review_stats counts agreement per kind and model and lists the survivors', async () => {
    const stats = (await call('review_stats')).out as {
      pending: number;
      counts: Record<string, unknown>[];
      survived: ReviewOut[];
    };
    expect(stats.pending).toBe(0);
    expect(stats.counts).toEqual([
      { kind: 'ai_fit_rejection', model: 'vendor/model-routed', agreed: 1, disagreed: 1 },
    ]);
    expect(stats.survived).toHaveLength(1);
    expect(stats.survived[0]).toMatchObject({
      status: 'confirmed',
      postings: [expect.objectContaining({ title: 'Weak alpha two' })],
    });
    const decided = (await call('list_reviews', { status: 'disagreed' })).out as {
      items: ReviewOut[];
    };
    expect(decided.items).toHaveLength(1);
  });

  it('an item whose kind has no applier yet is refused clearly and stays pending', async () => {
    const { id } = await review.create(userId, {
      kind: 'ai_merge',
      subject: { jobId: strongId, otherJobId: weakOne },
      model: 'vendor/model',
    });
    const res = await call('decide_review', { id, decision: 'confirm' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('ai_merge');
    expect((await pending()).map((i) => i.id)).toEqual([id]);
  });
});
