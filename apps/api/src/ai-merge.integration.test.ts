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
import { createAiMerge, createDiscovery } from '@job-portal/discovery';
import { createMatching } from '@job-portal/matching';
import { createDocuments } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

interface ItemOut {
  id: string;
  kind: string;
  status: string;
  model: string;
  postings: { url: string }[];
}

// AI merge through MCP: the runner is faked, everything else is real.
describe('AI merge over MCP', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;
  let pipeline: ReturnType<typeof createPipeline>;
  const runner: AiRunner = {
    name: 'openrouter',
    model: 'vendor/model',
    complete: () =>
      Promise.resolve({
        text: JSON.stringify({ same: true, reason: 'same role' }),
        model: 'vendor/model-routed',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      }),
  };
  const feed = [
    ['a', 'Alpha Developer Backend'],
    ['b', 'Alpha Developer Backend Senior'],
  ] as const;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    const discovery = createDiscovery(handle.db, [
      {
        id: 'feed',
        fetch: () =>
          Promise.resolve({
            postings: feed.map(([id, title]) => ({
              sourcePostingId: id,
              title,
              company: 'Beispiel Firma GmbH',
              location: 'Bamberg',
              url: `https://jobs.example.invalid/${id}`,
              raw: { id },
            })),
            errors: [],
          }),
      },
    ]);
    const tracker = createTracker(handle.db, discovery);
    const review = createReview(handle.db);
    const aiMerge = createAiMerge(handle.db, {
      ai: createAi(createAiLog(handle.db), runner),
      review,
      hasApplication: async (u, ids) => {
        const states = await tracker.getStates(u, ids);
        return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
      },
    });
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
    });
    pipeline = createPipeline(handle.db, discovery, { aiMerge });
    server = createApiServer({
      documents: createDocuments(handle.db),
      accounts,
      discovery,
      matching,
      pipeline,
      tracker,
      review,
      aiMerge,
      aiLog: createAiLog(handle.db),
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
      return { isError: res.isError === true, out: res.structuredContent as never };
    } finally {
      await client.close();
    }
  };
  const jobs = async () =>
    ((await call('list_jobs')).out as { jobs: { id: string; postings: unknown[] }[] }).jobs;

  it('a run raises an ai_merge item, the queue shows both postings, confirm merges, stats count it', async () => {
    const run = await pipeline.execute(userId, 'feed');
    expect(run).toMatchObject({ status: 'completed', aiMergeItems: 1, aiCalls: 1 });
    const both = (await jobs()).map((j) => j.id);
    expect(both).toHaveLength(2);

    const list = (await call('list_reviews', { kind: 'ai_merge' })).out as { items: ItemOut[] };
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(item).toMatchObject({
      kind: 'ai_merge',
      status: 'pending',
      model: 'vendor/model-routed',
    });
    expect(item?.postings.map((p) => p.url).sort()).toEqual([
      'https://jobs.example.invalid/a',
      'https://jobs.example.invalid/b',
    ]);

    // the next run asks nothing: the pair has an item
    expect(await pipeline.execute(userId, 'feed')).toMatchObject({ aiMergeItems: 0, aiCalls: 0 });

    const decided = await call('decide_review', { id: item?.id, decision: 'confirm' });
    expect(decided.isError).toBe(false);
    const after = await jobs();
    expect(after).toHaveLength(1);
    expect(after[0]?.postings).toHaveLength(2);

    // the folded Job is gone for every writer: the Tracker refuses it
    const folded = both.find((id) => id !== after[0]?.id) ?? '';
    expect(
      (await call('set_status', { jobId: folded, discoveryState: 'shortlisted' })).isError,
    ).toBe(true);
    expect((await call('add_note', { jobId: folded, text: 'x' })).isError).toBe(true);
    expect((await call('get_job', { jobId: folded })).isError).toBe(true);

    const stats = (await call('review_stats')).out as {
      counts: { kind: string; model: string; agreed: number }[];
    };
    expect(stats.counts).toContainEqual({
      kind: 'ai_merge',
      model: 'vendor/model-routed',
      agreed: 1,
      disagreed: 0,
    });

    const history = (await call('get_run_history')).out as { runs: { aiMergeItems: number }[] };
    expect(history.runs.map((r) => r.aiMergeItems)).toEqual([0, 1]);
  });
});
