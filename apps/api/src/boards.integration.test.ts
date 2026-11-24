import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import {
  createBoardDirectory,
  createWatchlist,
  type BoardDirectory,
  type Watchlist,
} from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from './server';

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../packages/discovery/src/sources/fixtures/${name}`, import.meta.url),
    'utf8',
  );
const greenhouseBoard = fixture('greenhouse-board.json');
const leverBoard = fixture('lever-board.json');

const TOKEN = 'placeholder-token-for-tests';
const EMAIL = 'user@example.invalid';

describe('Watchlist and add_board over MCP (recorded ATS responses, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;
  let directory: BoardDirectory;
  let watchlist: Watchlist;
  const requested: string[] = [];

  // Recorded responses: only the boards named "realco" exist; anything else answers 404. Nothing reaches the network.
  const fakeFetch: typeof fetch = (input) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(u);
    if (u.startsWith('https://boards-api.greenhouse.io/') && u.includes('/realco/'))
      return Promise.resolve(new Response(greenhouseBoard));
    if (u.startsWith('https://api.eu.lever.co/') && u.includes('/eulever?'))
      return Promise.resolve(new Response(leverBoard));
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser(EMAIL)).id;
    directory = createBoardDirectory(handle.db);
    watchlist = createWatchlist(handle.db);
    await directory.importBoards([
      { ats: 'greenhouse', token: 'listed', name: 'Listed' },
      { ats: 'ashby', token: 'other', name: 'Other' },
    ]);
    const discovery = createDiscovery(handle.db, []);
    server = createApiServer({
      accounts,
      discovery,
      pipeline: createPipeline(handle.db, discovery),
      boards: { directory, watchlist, fetch: fakeFetch },
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

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    isError: boolean;
    out: Record<string, unknown>;
    message: string;
  }> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const r = await client.callTool({ name, arguments: args });
    await client.close();
    const text = (r.content as { text: string }[])[0]?.text ?? '';
    return {
      isError: r.isError === true,
      out: (r.structuredContent ?? {}) as Record<string, unknown>,
      message: text,
    };
  }

  it('get_watchlist starts empty', async () => {
    expect((await call('get_watchlist')).out).toEqual({ boards: [] });
  });

  it('add_board verifies with one fetch, adds the board marked and watches it', async () => {
    requested.length = 0;
    const r = await call('add_board', { url: 'https://boards.greenhouse.io/realco/jobs/1' });
    expect(r.isError).toBe(false);
    expect(r.out).toMatchObject({ ats: 'greenhouse', token: 'realco' });
    expect(requested).toHaveLength(1);
    expect((await directory.listMarked('greenhouse')).map((b) => b.token)).toEqual(['realco']);
    expect((await call('get_watchlist')).out).toEqual({
      boards: [{ ats: 'greenhouse', token: 'realco' }],
    });
  });

  it('add_board keeps the Lever EU host and asks the EU API', async () => {
    requested.length = 0;
    const r = await call('add_board', { url: 'https://jobs.eu.lever.co/eulever' });
    expect(r.isError).toBe(false);
    expect(requested).toHaveLength(1);
    expect((await directory.listMarked('lever'))[0]).toMatchObject({
      token: 'eulever',
      host: 'eu',
    });
  });

  it.each([
    ['an unknown URL pattern', 'https://example.com/realco'],
    ['a path-traversal board id', 'https://jobs.lever.co/..'],
    ['a lookalike host', 'https://jobs.lever.co.evil.example/realco'],
  ])(
    'add_board refuses %s with a clear error, fetches nothing, changes nothing',
    async (_n, bad) => {
      requested.length = 0;
      const before = await watchlist.list(userId);
      const r = await call('add_board', { url: bad });
      expect(r.isError).toBe(true);
      expect(r.message).toMatch(/Greenhouse, Lever or Ashby careers URL/);
      expect(requested).toEqual([]);
      expect(await watchlist.list(userId)).toEqual(before);
    },
  );

  it('add_board refuses a board that fails verification and changes nothing', async () => {
    const before = await watchlist.list(userId);
    const r = await call('add_board', { url: 'https://jobs.ashbyhq.com/ghostco' });
    expect(r.isError).toBe(true);
    expect(r.message).toMatch(/ashby board ghostco.*HTTP 404/);
    expect((await directory.listMarked('ashby')).map((b) => b.token)).toEqual([]);
    expect(await watchlist.list(userId)).toEqual(before);
  });

  it('update_watchlist adds and removes boards from the directory and returns the list', async () => {
    const added = await call('update_watchlist', {
      add: [{ ats: 'greenhouse', token: 'listed' }],
      remove: [{ ats: 'lever', token: 'eulever' }],
    });
    expect(added.out).toEqual({
      boards: [
        { ats: 'greenhouse', token: 'listed' },
        { ats: 'greenhouse', token: 'realco' },
      ],
    });
    const removed = await call('update_watchlist', {
      remove: [{ ats: 'greenhouse', token: 'listed' }],
    });
    expect(removed.out).toEqual({ boards: [{ ats: 'greenhouse', token: 'realco' }] });
  });

  it('update_watchlist refuses a board not in the directory and changes nothing', async () => {
    const r = await call('update_watchlist', {
      add: [
        { ats: 'ashby', token: 'other' },
        { ats: 'ashby', token: 'missing' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.message).toMatch(/not in the Board directory: ashby\/missing/);
    expect(await watchlist.list(userId)).toEqual([{ ats: 'greenhouse', token: 'realco' }]);
  });
});
