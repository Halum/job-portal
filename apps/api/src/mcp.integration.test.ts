import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountsMigrations, createAccounts } from '@job-portal/accounts';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  createBundesagenturSource,
  createDiscovery,
  discoveryMigrations,
} from '@job-portal/discovery';
import { createPipeline, pipelineMigrations } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const fixture = readFileSync(
  new URL(
    '../../../packages/discovery/src/sources/fixtures/bundesagentur-search.json',
    import.meta.url,
  ),
  'utf8',
);
const fakeFetch = (() =>
  Promise.resolve(new Response(fixture, { status: 200 }))) as unknown as typeof fetch;

const TOKEN = 'placeholder-token-for-tests';
const EMAIL = 'user@example.invalid';

describe('MCP endpoint over real HTTP', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      accountsMigrations,
      discoveryMigrations,
      pipelineMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser(EMAIL)).id;
    const discovery = createDiscovery(handle.db, [
      createBundesagenturSource({ query: 'wo=Musterstadt', fetch: fakeFetch }),
    ]);
    const pipeline = createPipeline(handle.db, discovery);
    await pipeline.execute(userId, 'bundesagentur');
    server = createApiServer({
      accounts,
      discovery,
      pipeline,
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

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return client;
  }

  it('lists the tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_job', 'get_run_history', 'list_jobs', 'whoami']);
    await client.close();
  });

  it('whoami returns the seeded user for a valid token', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toEqual({
      id: userId,
      email: EMAIL,
      timezone: 'Europe/Berlin',
    });
    await client.close();
  });

  it('list_jobs returns the stored Jobs with their postings, paged by cursor', async () => {
    const client = await connect();
    const first = (await client.callTool({ name: 'list_jobs', arguments: { limit: 3 } }))
      .structuredContent as { jobs: { postings: unknown[] }[]; nextCursor: string | null };
    expect(first.jobs).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(first.jobs[0]?.postings).toHaveLength(1);

    const second = (
      await client.callTool({
        name: 'list_jobs',
        arguments: { limit: 3, cursor: first.nextCursor },
      })
    ).structuredContent as { jobs: unknown[]; nextCursor: string | null };
    expect(second.jobs).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    await client.close();
  });

  it('get_job returns a Job with the raw posting, and an error for an unknown id', async () => {
    const client = await connect();
    const { jobs } = (await client.callTool({ name: 'list_jobs', arguments: {} }))
      .structuredContent as { jobs: { id: string; title: string }[] };
    const id = jobs[0]?.id ?? '';

    const found = await client.callTool({ name: 'get_job', arguments: { jobId: id } });
    expect(found.structuredContent).toMatchObject({
      job: {
        id,
        postings: [{ sourceId: 'bundesagentur', raw: { stellenangebotsTitel: jobs[0]?.title } }],
      },
    });

    const missing = await client.callTool({
      name: 'get_job',
      arguments: { jobId: '00000000-0000-4000-8000-0000000000ff' },
    });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it('get_run_history returns the recorded runs with their counts', async () => {
    const client = await connect();
    const { runs } = (await client.callTool({ name: 'get_run_history', arguments: {} }))
      .structuredContent as { runs: unknown[] };
    expect(runs).toEqual([
      expect.objectContaining({
        sourceId: 'bundesagentur',
        status: 'completed',
        fetched: 5,
        newPostings: 5,
        errors: [],
      }),
    ]);
    await client.close();
  });

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    },
  };
  const post = (headers: Record<string, string>): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize),
    });

  it('rejects a request without a token with 401', async () => {
    expect((await post({})).status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    expect((await post({ Authorization: 'Bearer not-the-right-token' })).status).toBe(401);
  });

  it('answers 405 to GET and 404 to other paths for an authenticated caller', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(new URL('/other', url), { headers: auth })).status).toBe(404);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
  });

  it('answers 413 to a body over 1 MB', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
  });
});
