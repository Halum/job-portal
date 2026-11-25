import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createAccounts } from '@job-portal/accounts';
import { createAiLog } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { createDocuments } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createMatching, type Matching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';
const UNKNOWN = '00000000-0000-4000-8000-000000000997';

describe('Target career banks through the API', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let base: string;
  let matching: Matching;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    const discovery = createDiscovery(handle.db, []);
    matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
    });
    server = createApiServer({
      accounts,
      documents: createDocuments(handle.db, {
        hasTarget: async (u, targetId) =>
          (await matching.listTargets(u)).some((t) => t.id === targetId),
      }),
      review: createReview(handle.db),
      discovery,
      matching,
      pipeline: createPipeline(handle.db, discovery),
      tracker: createTracker(handle.db, discovery),
      aiLog: createAiLog(handle.db),
      boards: {
        watchlist: createWatchlist(handle.db),
        fetch: () => Promise.reject(new Error('no network in tests')),
        allowAddBoard: () => Promise.resolve(true),
      },
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: auth },
      }),
    );
  });
  afterAll(async () => {
    await client.close();
  });

  interface Marked {
    id: string;
    source?: string;
    stale?: boolean;
    overrideId?: string | null;
    text?: string;
    [key: string]: unknown;
  }
  interface Out {
    override: { id: string; action: string; itemKind: string; baseRevisionId: string | null };
    item: { id: string };
    revisions: {
      reason: string;
      itemKind: string;
      actor: string;
      oldValue: unknown;
      newValue: Record<string, unknown>;
    }[];
    workExperiences: (Marked & { points: Marked[] })[];
    resumeEntries: Marked[];
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? '';
    return { isError: r.isError === true, out: r.structuredContent as Out, text };
  };
  const upsert = (itemKind: string, value: Record<string, unknown>, more = {}) =>
    call('upsert_career_item', { itemKind, value, reason: 'user_edit', ...more });
  const target = async (name: string, user = userId) =>
    (await matching.upsertTarget(user, { name })).id;
  const point = (text: string) => ({ text, skills: ['kochen'] });
  const work = {
    role: 'Koch',
    organisation: 'Muster Küche GmbH',
    start: '2020-03',
    end: null,
    place: null,
  };
  const setOverride = (args: Record<string, unknown>) =>
    call('set_career_override', { reason: 'user_edit', ...args });
  const resolved = async (targetId: string, jobId: string) =>
    (await call('get_career_bank', { targetId })).out.workExperiences.find((w) => w.id === jobId);
  const setup = async () => {
    const job = (await upsert('work_experience', work)).out.item.id;
    const a = (await upsert('experience_point', point('Kochte 80 Essen'), { parentId: job })).out
      .item.id;
    const b = (await upsert('experience_point', point('Schulte zwei Azubis'), { parentId: job }))
      .out.item.id;
    return { job, a, b };
  };

  it('hides, replaces and adds for a Target; get_career_bank with the Target marks each item', async () => {
    const { job, a, b } = await setup();
    const t = await target('kitchen');
    expect((await setOverride({ targetId: t, action: 'hide', itemId: a })).isError).toBe(false);
    await setOverride({
      targetId: t,
      action: 'replace',
      itemId: b,
      value: point('Leitete Azubis an'),
    });
    const added = await setOverride({
      targetId: t,
      action: 'add',
      itemKind: 'experience_point',
      parentId: job,
      value: point('Nur hier'),
    });

    const shown = (await resolved(t, job))?.points.map((p) => [p.id, p.source, p.text]);
    expect(shown).toEqual([
      [a, 'hidden', 'Kochte 80 Essen'],
      [b, 'replaced', 'Leitete Azubis an'],
      [added.out.override.id, 'added', 'Nur hier'],
    ]);

    // Without a Target the Career bank is unchanged and carries no markers.
    const plain = (await call('get_career_bank')).out.workExperiences.find((w) => w.id === job);
    expect(plain?.points.map((p) => [p.id, p.text, p.source])).toEqual([
      [a, 'Kochte 80 Essen', undefined],
      [b, 'Schulte zwei Azubis', undefined],
    ]);
    const other = await target('office');
    expect((await resolved(other, job))?.points.map((p) => p.source)).toEqual([
      'inherited',
      'inherited',
    ]);
  });

  it('returns a replacement with the stale flag after the Career bank item changed', async () => {
    const { job, b } = await setup();
    const t = await target('stale');
    await setOverride({ targetId: t, action: 'replace', itemId: b, value: point('Ziel-Text') });
    expect((await resolved(t, job))?.points[1]).toMatchObject({ source: 'replaced', stale: false });
    await upsert('experience_point', point('Bank-Text neu'), { itemId: b });
    expect((await resolved(t, job))?.points[1]).toMatchObject({ text: 'Ziel-Text', stale: true });
  });

  it('writes revisions of item kind override for set, change and clear, and clear restores inheritance', async () => {
    const { job, a } = await setup();
    const t = await target('history');
    const first = await setOverride({ targetId: t, action: 'hide', itemId: a });
    await setOverride({ targetId: t, action: 'replace', itemId: a, value: point('Neu') });
    const id = first.out.override.id;
    expect((await call('clear_career_override', { overrideId: id })).isError).toBe(false);
    const revisions = (await call('list_career_revisions', { itemId: id })).out.revisions;
    expect(revisions.map((r) => [r.itemKind, r.reason, r.actor])).toEqual([
      ['override', 'user_edit', 'skill'],
      ['override', 'user_edit', 'skill'],
      ['override', 'restore', 'skill'],
    ]);
    expect(revisions[0]?.newValue).toMatchObject({ targetId: t, action: 'hide', itemId: a });
    expect((await resolved(t, job))?.points.map((p) => p.source)).toEqual([
      'inherited',
      'inherited',
    ]);
    expect((await call('clear_career_override', { overrideId: id })).isError).toBe(true);
  });

  it('refuses a foreign or unknown Target, item and override, and a value of the wrong shape', async () => {
    const { job, a } = await setup();
    const t = await target('guard');
    const foreignTarget = await target('theirs', OTHER_USER);
    const refused = async (r: Promise<{ isError: boolean }>) => (await r).isError;

    expect(await refused(setOverride({ targetId: foreignTarget, action: 'hide', itemId: a }))).toBe(
      true,
    );
    expect(await refused(setOverride({ targetId: UNKNOWN, action: 'hide', itemId: a }))).toBe(true);
    expect(await refused(call('get_career_bank', { targetId: foreignTarget }))).toBe(true);
    expect(await refused(call('get_career_bank', { targetId: UNKNOWN }))).toBe(true);
    expect(await refused(setOverride({ targetId: t, action: 'hide', itemId: UNKNOWN }))).toBe(true);
    expect(
      await refused(
        setOverride({ targetId: t, action: 'replace', itemId: a, value: { text: '' } }),
      ),
    ).toBe(true);
    expect(
      await refused(
        setOverride({
          targetId: t,
          action: 'add',
          itemKind: 'experience_point',
          value: point('x'),
        }),
      ),
    ).toBe(true);
    expect(await refused(call('clear_career_override', { overrideId: UNKNOWN }))).toBe(true);
    expect((await resolved(t, job))?.points.map((p) => p.source)).toEqual([
      'inherited',
      'inherited',
    ]);
  });

  it("refuses another user's override id", async () => {
    const { a } = await setup();
    const t = await target('mine');
    const mine = (await setOverride({ targetId: t, action: 'hide', itemId: a })).out.override.id;
    // The MCP endpoint serves one bearer user, so another user's id is tried through the module.
    const theirs = createDocuments(handle.db);
    await expect(theirs.clearOverride(OTHER_USER, mine, 'user')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
