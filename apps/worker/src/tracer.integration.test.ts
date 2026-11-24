import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  bundesagenturQuery,
  createBundesagenturSource,
  createDiscovery,
} from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from '@job-portal/api';
import { createTracker } from '@job-portal/tracker';
import { startWorker, type WorkerHandle } from './worker';

// Tracer bullet: a Target -> Bundesagentur search (recorded response) -> BullMQ schedule -> Pipeline
// -> Discovery -> Matching (hard filters, prerank) -> Postgres -> MCP tools over real HTTP. Only the
// Bundesagentur HTTP call is faked.
const TOKEN = 'placeholder-token-for-tests';
const fixtureText = readFileSync(
  new URL(
    '../../../packages/discovery/src/sources/fixtures/bundesagentur-search.json',
    import.meta.url,
  ),
  'utf8',
);
const fixture = JSON.parse(fixtureText) as { ergebnisliste: { referenznummer: string }[] };
const apiUrls: string[] = [];
const fakeFetch = ((input: string) => {
  apiUrls.push(input);
  return Promise.resolve(new Response(fixtureText, { status: 200 }));
}) as unknown as typeof fetch;

describe('Bundesagentur source to MCP list_jobs', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let handle: DbHandle;
  let worker: WorkerHandle;
  let server: Server;
  let client: Client;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    await runMigrationsWithLock(pg.getConnectionUri(), allMigrations);
    handle = createDb(pg.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    const user = await accounts.seedUser('user@example.invalid');
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
    });
    const discovery = createDiscovery(handle.db, [
      createBundesagenturSource({
        queries: async () => (await matching.searchQueries(user.id)).map(bundesagenturQuery),
        fetch: fakeFetch,
      }),
    ]);
    // Placeholder search: "Musterstadt" is not in the place table, so the radius cannot be checked.
    await matching.upsertTarget(user.id, {
      name: 'odd minijob',
      criteria: { keywords: ['koch'], locations: ['Musterstadt'], radiusKm: 7 },
    });
    const tracker = createTracker(handle.db, discovery);
    const pipeline = createPipeline(handle.db, discovery, { matching });
    const logger = createLogger({ level: 'silent' });

    worker = await startWorker({
      redisUrl: redis.getConnectionUrl(),
      pipeline,
      userId: user.id,
      sources: [{ sourceId: 'bundesagentur', intervalMinutes: 1 }],
      logger,
    });
    server = createApiServer({
      accounts,
      discovery,
      matching,
      pipeline,
      tracker,
      boards: {
        watchlist: createWatchlist(handle.db),
        fetch: () => Promise.reject(new Error('no network in tests')),
        allowAddBoard: () => Promise.resolve(true),
      },
      logger,
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
    await worker.close();
    await handle.close();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  async function runs(): Promise<{ status: string; fetched: number; newPostings: number }[]> {
    const result = await client.callTool({ name: 'get_run_history', arguments: {} });
    return (
      result.structuredContent as {
        runs: { status: string; fetched: number; newPostings: number }[];
      }
    ).runs;
  }

  it('shows the scheduled run, its jobs and their postings through MCP', async () => {
    const deadline = Date.now() + 15_000;
    while (!(await runs()).some((r) => r.status === 'completed')) {
      if (Date.now() > deadline) throw new Error('run did not complete');
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(await runs()).toEqual([
      expect.objectContaining({
        status: 'completed',
        fetched: 5,
        newPostings: 5,
        prerankPassed: 1, // only the Koch posting matches the keyword
      }),
    ]);

    const list = (await client.callTool({ name: 'list_jobs', arguments: {} }))
      .structuredContent as {
      jobs: { id: string; title: string; postings: { sourcePostingId: string; url: string }[] }[];
    };
    expect(list.jobs.map((j) => j.postings[0]?.sourcePostingId).sort()).toEqual(
      fixture.ergebnisliste.map((r) => r.referenznummer).sort(),
    );
    const koch = list.jobs.find((j) => j.title === 'Koch (m/w/d)');
    expect(koch?.postings[0]?.url).toBe(
      'https://www.arbeitsagentur.de/jobsuche/jobdetail/18024-0000000002-S',
    );

    const detail = await client.callTool({ name: 'get_job', arguments: { jobId: koch?.id } });
    expect(detail.structuredContent).toMatchObject({
      job: { title: 'Koch (m/w/d)', postings: [{ raw: { hauptberuf: 'Koch/Köchin' } }] },
    });
    expect(apiUrls).toHaveLength(1);
    const params = new URL(apiUrls[0] ?? '').searchParams;
    expect([params.get('was'), params.get('wo'), params.get('umkreis')]).toEqual([
      'koch',
      'Musterstadt',
      '7',
    ]);

    // list_jobs by Target returns the one Job that passed, flagged candidate only for that Target.
    const target = (
      (await client.callTool({ name: 'list_targets', arguments: {} })).structuredContent as {
        targets: { id: string }[];
      }
    ).targets[0];
    const byTarget = (
      await client.callTool({ name: 'list_jobs', arguments: { targetId: target?.id } })
    ).structuredContent as { jobs: { id: string }[] };
    expect(byTarget.jobs.map((j) => j.id)).toEqual([koch?.id]);
  });
});
