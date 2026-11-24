import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountsMigrations, createAccounts } from '@job-portal/accounts';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

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
    await runMigrationsWithLock(container.getConnectionUri(), [accountsMigrations]);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser(EMAIL)).id;
    server = createApiServer(accounts, createLogger({ level: 'silent' }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  it('whoami returns the seeded user for a valid token', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['whoami']);

    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toEqual({
      id: userId,
      email: EMAIL,
      timezone: 'Europe/Berlin',
    });
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
});
