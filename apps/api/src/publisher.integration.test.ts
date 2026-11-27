import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import { createAiLog } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, type Source } from '@job-portal/discovery';
import { createDocuments } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createTracker } from '@job-portal/tracker';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

let publisher = 'LinkedIn';
const aggregator: Source = {
  id: 'fake-aggregator',
  fetch: () =>
    Promise.resolve({
      postings: [
        {
          sourcePostingId: 'p1',
          title: 'Aggregated role',
          company: 'Beispiel Firma',
          location: 'Musterstadt',
          url: 'https://jobs.example.invalid/p1',
          publisher,
          raw: { id: 'p1' },
        },
      ],
      errors: [],
    }),
};

describe('Publisher through the MCP endpoint', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let client: Client;
  let userId: string;
  let pipeline: ReturnType<typeof createPipeline>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    const discovery = createDiscovery(handle.db, [aggregator]);
    pipeline = createPipeline(handle.db, discovery);
    await pipeline.execute(userId, 'fake-aggregator');
    const tracker = createTracker(handle.db, discovery);
    server = createApiServer({
      documents: createDocuments(handle.db),
      review: createReview(handle.db),
      accounts,
      discovery,
      matching: createMatching(handle.db, {
        loadJobs: (u, ids) => discovery.listMatchable(u, ids),
        hasApplication: () => Promise.resolve(new Set<string>()),
      }),
      pipeline,
      tracker,
      aiLog: createAiLog(handle.db),
      boards: {
        watchlist: createWatchlist(handle.db),
        fetch: () => Promise.reject(new Error('no network in tests')),
        allowAddBoard: () => Promise.resolve(true),
      },
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  const publisherOf = async (tool: 'list_jobs' | 'get_job'): Promise<unknown> => {
    const listed = (await client.callTool({ name: 'list_jobs', arguments: {} }))
      .structuredContent as { jobs: { id: string; postings: { publisher: string | null }[] }[] };
    const job = listed.jobs[0];
    if (tool === 'list_jobs') return job?.postings[0]?.publisher;
    const got = (await client.callTool({ name: 'get_job', arguments: { jobId: job?.id ?? '' } }))
      .structuredContent as { job: { postings: { publisher: string | null }[] } };
    return got.job.postings[0]?.publisher;
  };

  it('list_jobs and get_job show the Publisher, and a re-fetch with a changed one updates it', async () => {
    expect(await publisherOf('list_jobs')).toBe('LinkedIn');
    expect(await publisherOf('get_job')).toBe('LinkedIn');

    publisher = 'Indeed';
    await pipeline.execute(userId, 'fake-aggregator');
    expect(await publisherOf('get_job')).toBe('Indeed');
  });
});
