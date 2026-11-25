import { readFileSync } from 'node:fs';
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
import { ADD_JOB_LIMITS, createBundesagenturSource, createDiscovery } from '@job-portal/discovery';
import { createDocuments } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createTracker } from '@job-portal/tracker';
import { createReview } from '@job-portal/review';
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
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser(EMAIL)).id;
    const discovery = createDiscovery(handle.db, [
      createBundesagenturSource({ query: 'wo=Musterstadt', fetch: fakeFetch }),
    ]);
    const pipeline = createPipeline(handle.db, discovery);
    await pipeline.execute(userId, 'bundesagentur');
    const tracker = createTracker(handle.db, discovery);
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
      hasApplication: async (u, ids) => {
        const states = await tracker.getStates(u, ids);
        return new Set(ids.filter((id) => states.get(id)?.applicationStatus != null));
      },
    });
    server = createApiServer({
      documents: createDocuments(handle.db),
      review: createReview(handle.db),
      accounts,
      discovery,
      matching,
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
    url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`);
  });

  afterAll(async () => {
    const b = serverB;
    if (b) await new Promise((resolve) => b.close(resolve));
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
    expect(names).toEqual([
      'add_board',
      'add_job',
      'add_note',
      'clear_career_override',
      'decide_review',
      'get_application_packet',
      'get_career_bank',
      'get_global_defaults',
      'get_job',
      'get_run_history',
      'get_watchlist',
      'hide_career_item',
      'list_application_packets',
      'list_career_revisions',
      'list_jobs',
      'list_reviews',
      'list_targets',
      'mark_packet_sent',
      'register_master_document',
      'restore_career_item',
      'review_stats',
      'save_application_packet',
      'save_career_bank',
      'set_career_override',
      'set_status',
      'split_job',
      'undo_last_change',
      'update_global_defaults',
      'update_watchlist',
      'upsert_career_item',
      'upsert_target',
      'whoami',
    ]);
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

  it('list_jobs refuses a malformed cursor with a clean tool error', async () => {
    const client = await connect();
    const outcome = await client
      .callTool({ name: 'list_jobs', arguments: { cursor: 'not-a-uuid' } })
      .catch((err: unknown) => err);
    const message = JSON.stringify(outcome instanceof Error ? outcome.message : outcome);
    expect(message).toMatch(/cursor/i);
    expect(message).not.toMatch(/invalid input syntax|postgres/i);
    // The endpoint still works afterwards.
    expect((await client.callTool({ name: 'list_jobs', arguments: {} })).isError).toBeFalsy();
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

  it('add_job creates a manual Job, a repeat merges, and split_job undoes a merge', async () => {
    const client = await connect();
    const add = (args: Record<string, string>) =>
      client.callTool({ name: 'add_job', arguments: args });
    const input = { title: 'Koch', company: 'Beispiel GmbH', city: 'Musterstadt' };
    const first = (await add({ ...input, url: 'https://x.example.invalid/j/1' }))
      .structuredContent as { jobId: string };
    // A different URL but the same company key merges into the same Job.
    const second = (await add({ ...input, url: 'https://y.example.invalid/j/9' }))
      .structuredContent as { jobId: string };
    expect(second.jobId).toBe(first.jobId);

    const job = (await client.callTool({ name: 'get_job', arguments: { jobId: first.jobId } }))
      .structuredContent as { job: { postings: { id: string; sourceId: string }[] } };
    expect(job.job.postings.map((p) => p.sourceId)).toEqual(['manual', 'manual']);

    const moved = job.job.postings[1]?.id ?? '';
    const split = await client.callTool({
      name: 'split_job',
      arguments: { jobId: first.jobId, postingIds: [moved] },
    });
    const { jobId: newJobId, splitCount } = split.structuredContent as {
      jobId: string;
      splitCount: number;
    };
    expect(newJobId).not.toBe(first.jobId);
    expect(splitCount).toBe(1);

    const refused = await client.callTool({
      name: 'split_job',
      arguments: { jobId: newJobId, postingIds: [moved] },
    });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      out: res.structuredContent as never,
      text: JSON.stringify(res.content),
    };
  };

  it('tracks a Job: set_status, a refused second Applied, notes, undo, and the timeline in get_job', async () => {
    const client = await connect();
    const { out: added } = await call(client, 'add_job', {
      title: 'Spüler',
      url: 'https://z.example.invalid/1',
    });
    const jobId = (added as { jobId: string }).jobId;

    expect(
      (await call(client, 'set_status', { jobId, discoveryState: 'shortlisted' })).isError,
    ).toBe(false);
    const applied = await call(client, 'set_status', {
      jobId,
      applicationStatus: 'applied',
      appliedOn: '2026-11-01',
      applyBy: '2026-12-01',
      actor: 'skill',
    });
    expect(applied.out).toMatchObject({
      tracking: {
        applicationStatus: 'applied',
        furthestStage: 'applied',
        appliedOn: '2026-11-01',
        applyBy: '2026-12-01',
      },
    });
    const again = await call(client, 'set_status', { jobId, applicationStatus: 'applied' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already applied on 2026-11-01');
    expect((await call(client, 'set_status', { jobId })).isError).toBe(true);
    expect(
      (
        await call(client, 'set_status', {
          jobId,
          discoveryState: 'new',
          applicationStatus: 'applied',
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(client, 'set_status', {
          jobId: '00000000-0000-4000-8000-0000000000ff',
          discoveryState: 'new',
        })
      ).isError,
    ).toBe(true);

    await call(client, 'add_note', { jobId, text: 'phoned them' });
    const got = (await call(client, 'get_job', { jobId })).out as {
      job: {
        tracking: { applicationStatus: string };
        timeline: { to: string; actor: string }[];
        notes: { text: string }[];
      };
    };
    expect(got.job.tracking.applicationStatus).toBe('applied');
    expect(got.job.timeline.map((e) => [e.to, e.actor])).toEqual([
      ['shortlisted', 'user'],
      ['applied', 'skill'],
    ]);
    expect(got.job.notes.map((n) => n.text)).toEqual(['phoned them']);

    const undone = await call(client, 'undo_last_change', { jobId });
    expect(undone.out).toMatchObject({
      tracking: { applicationStatus: null, furthestStage: null },
    });
    const twice = await call(client, 'undo_last_change', { jobId });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('already an undo');
    await call(client, 'set_status', {
      jobId,
      applicationStatus: 'applied',
      appliedOn: '2026-11-01',
      applyBy: '2026-12-01',
    });
    await client.close();
  });

  it('list_jobs filters by discovery state, application status, apply-by and discovered date, and pages the result', async () => {
    const client = await connect();
    const ids = async (
      args: Record<string, unknown>,
    ): Promise<{ ids: string[]; next: string | null; states: string[] }> => {
      const { out } = await call(client, 'list_jobs', args);
      const o = out as {
        jobs: { id: string; tracking: { discoveryState: string } }[];
        nextCursor: string | null;
      };
      return {
        ids: o.jobs.map((j) => j.id),
        next: o.nextCursor,
        states: o.jobs.map((j) => j.tracking.discoveryState),
      };
    };
    const applied = await ids({ applicationStatus: 'applied' });
    expect(applied.ids).toHaveLength(1);
    expect((await ids({ discoveryState: 'shortlisted' })).ids).toEqual(applied.ids);
    expect((await ids({ applyByBefore: '2026-12-31' })).ids).toEqual(applied.ids);
    expect((await ids({ applyByBefore: '2026-11-30' })).ids).toEqual([]);
    expect((await ids({ discoveredSince: '2999-01-01T00:00:00Z' })).ids).toEqual([]);
    expect((await ids({ discoveredSince: '2000-01-01T00:00:00Z' })).ids.length).toBeGreaterThan(5);

    const first = await ids({ discoveryState: 'new', limit: 2 });
    expect(first.ids).toHaveLength(2);
    expect(first.states).toEqual(['new', 'new']);
    expect(first.next).not.toBeNull();
    const second = await ids({ discoveryState: 'new', limit: 2, cursor: first.next });
    expect(second.ids.every((i) => !first.ids.includes(i) && !applied.ids.includes(i))).toBe(true);
    await client.close();
  });

  it('a Dismissed Job stays as a marker: a later copy merges into it instead of creating a Job', async () => {
    const client = await connect();
    const input = { title: 'Barista', company: 'Marker GmbH', city: 'Ort' };
    const first = (await call(client, 'add_job', { ...input, url: 'https://m.example.invalid/1' }))
      .out as { jobId: string };
    await call(client, 'set_status', { jobId: first.jobId, discoveryState: 'dismissed' });
    const copy = (await call(client, 'add_job', { ...input, url: 'https://n.example.invalid/2' }))
      .out as { jobId: string };
    expect(copy.jobId).toBe(first.jobId);
    await client.close();
  });

  it('add_job refuses a URL that is not http(s)', async () => {
    const client = await connect();
    const outcome = await client
      .callTool({ name: 'add_job', arguments: { title: 'Koch', url: 'not a url' } })
      .catch((err: unknown) => err);
    expect(JSON.stringify(outcome instanceof Error ? outcome.message : outcome)).toMatch(/url/i);
    await client.close();
  });

  it('add_job refuses other schemes and over-long fields', async () => {
    const client = await connect();
    const refused = async (args: Record<string, string>): Promise<boolean> => {
      const outcome = await client
        .callTool({ name: 'add_job', arguments: args })
        .catch((err: unknown) => err);
      return outcome instanceof Error || Boolean((outcome as { isError?: boolean }).isError);
    };
    const ok = { title: 'Koch', url: 'https://x.example.invalid/j/77' };
    expect(await refused({ ...ok, url: 'ftp://x.example.invalid/j' })).toBe(true);
    expect(await refused({ ...ok, url: 'javascript:alert(1)' })).toBe(true);
    expect(await refused({ ...ok, title: 'x'.repeat(ADD_JOB_LIMITS.title + 1) })).toBe(true);
    expect(await refused({ ...ok, company: 'x'.repeat(ADD_JOB_LIMITS.company + 1) })).toBe(true);
    expect(await refused({ ...ok, city: 'x'.repeat(ADD_JOB_LIMITS.city + 1) })).toBe(true);
    const longUrl = `https://x.example.invalid/${'a'.repeat(ADD_JOB_LIMITS.url)}`;
    expect(await refused({ ...ok, url: longUrl })).toBe(true);
    expect(await refused({ ...ok, url: 'http://x.example.invalid/j/78' })).toBe(false);
    expect(await refused(ok)).toBe(false);
    await client.close();
  });

  it('add_job and split_job answer with a fixed text, never a raw database error', async () => {
    const client = await connect();
    // A NUL byte passes the schema and makes Postgres refuse the insert.
    const bad = await client.callTool({
      name: 'add_job',
      arguments: { title: `Koch${String.fromCharCode(0)}`, url: 'https://x.example.invalid/j/nul' },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toBe(
      JSON.stringify([{ type: 'text', text: 'add_job failed' }]),
    );
    // An expected refusal keeps its own message.
    const missing = await client.callTool({
      name: 'split_job',
      arguments: {
        jobId: '00000000-0000-4000-8000-0000000000ff',
        postingIds: ['00000000-0000-4000-8000-0000000000fe'],
      },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('No Job');
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
        errorCount: 0,
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

  // A second server over the same database that authenticates every request as another user.
  const USER_B = '00000000-0000-4000-8000-0000000000b2';
  let serverB: Server | undefined;
  async function createUserB(): Promise<URL> {
    if (!serverB) {
      const discovery = createDiscovery(handle.db, []);
      serverB = createApiServer({
        documents: createDocuments(handle.db),
        review: createReview(handle.db),
        accounts: {
          authenticate: () =>
            Promise.resolve({ id: USER_B, email: 'b@example.invalid', timezone: 'UTC' }),
          seedUser: () => Promise.reject(new Error('unused')),
        },
        discovery,
        matching: createMatching(handle.db, {
          loadJobs: (u, ids) => discovery.listMatchable(u, ids),
        }),
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
      const s = serverB;
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    }
    return new URL(`http://127.0.0.1:${String((serverB.address() as AddressInfo).port)}/mcp`);
  }

  describe('Targets and Global defaults', () => {
    type TargetOut = {
      id: string;
      name: string;
      paused: boolean;
      criteria: Record<string, unknown>;
      resolved: Record<string, unknown>;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const client = await connect();
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await client.close();
      }
    };

    it('upserts a Target by name, patches it, and shows what it resolves to', async () => {
      await call('update_global_defaults', {
        criteria: { exclusionWords: ['Spam'], radiusKm: 7, alertThreshold: 70 },
      });
      const made = (
        await call('upsert_target', {
          name: 'odd minijob',
          criteria: { keywords: ['alpha'], exclusionWords: ['Zeitarbeit'], alertThreshold: 0 },
        })
      ).structuredContent as { target: TargetOut };
      expect(made.target.paused).toBe(false);
      expect(made.target.criteria).toMatchObject({ keywords: ['alpha'], radiusKm: null });
      expect(made.target.resolved).toMatchObject({
        radiusKm: 7,
        alertThreshold: 0,
        exclusionWords: ['Spam', 'Zeitarbeit'],
      });

      const patched = (
        await call('upsert_target', {
          name: 'odd minijob',
          paused: true,
          criteria: { radiusKm: 0, keywords: null },
        })
      ).structuredContent as { target: TargetOut };
      expect(patched.target.id).toBe(made.target.id);
      expect(patched.target.paused).toBe(true);
      expect(patched.target.criteria).toMatchObject({ radiusKm: 0, keywords: null });
      expect(patched.target.criteria['exclusionWords']).toEqual(['Zeitarbeit']);

      const listed = (await call('list_targets', {})).structuredContent as { targets: TargetOut[] };
      expect(listed.targets.map((t) => t.name)).toEqual(['odd minijob']);
      const defaults = (await call('get_global_defaults', {})).structuredContent as {
        defaults: Record<string, unknown>;
      };
      expect(defaults.defaults).toMatchObject({ radiusKm: 7, exclusionWords: ['Spam'] });
    });

    it('refuses values the zero rules forbid with a tool error', async () => {
      for (const [name, args] of [
        ['upsert_target', { name: 'bad', criteria: { prerankTopN: 0 } }],
        ['update_global_defaults', { criteria: { alertThreshold: 101 } }],
        ['upsert_target', { name: ' ' }],
      ] as const) {
        const outcome = await call(name, args).catch((err: unknown) => err);
        const failed = outcome instanceof Error || (outcome as { isError?: boolean }).isError;
        expect(failed).toBe(true);
      }
      const listed = (await call('list_targets', {})).structuredContent as { targets: TargetOut[] };
      expect(listed.targets.map((t) => t.name)).not.toContain('bad');
    });

    it('stores the salary floor but says in the tool description it is not enforced yet', async () => {
      const client = await connect();
      const tool = (await client.listTools()).tools.find((t) => t.name === 'upsert_target');
      await client.close();
      expect(tool?.description).toContain('salaryFloor is stored but not enforced yet');
    });

    it('refuses criteria lists and words over the caps', async () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `w${String(i)}`);
      for (const criteria of [{ keywords: tooMany }, { blockedCompanies: ['x'.repeat(101)] }]) {
        const outcome = await call('upsert_target', { name: 'caps', criteria }).catch(
          (err: unknown) => err,
        );
        const failed = outcome instanceof Error || (outcome as { isError?: boolean }).isError;
        expect(failed).toBe(true);
      }
    });

    it('does not match a Job that has an application status', async () => {
      const ids = async (targetId: string): Promise<string[]> =>
        (
          (await call('list_jobs', { targetId })).structuredContent as { jobs: { id: string }[] }
        ).jobs.map((j) => j.id);
      const made = (await call('upsert_target', { name: 'after applying' })).structuredContent as {
        target: TargetOut;
      };
      const before = await ids(made.target.id);
      const applied = before[0] ?? '';
      expect(applied).not.toBe('');
      await call('set_status', { jobId: applied, applicationStatus: 'applied' });
      await call('upsert_target', { name: 'after applying' }); // rematch
      expect(await ids(made.target.id)).toEqual(before.filter((id) => id !== applied));
    });

    it("user B cannot read or edit user A's Targets", async () => {
      const made = (
        await call('upsert_target', { name: 'mine', criteria: { keywords: ['alpha'] } })
      ).structuredContent as { target: TargetOut };
      const other = await createUserB();
      const asB = async (name: string, args: Record<string, unknown>) => {
        const client = new Client({ name: 'b', version: '0.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(other, {
            requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
          }),
        );
        try {
          return await client.callTool({ name, arguments: args });
        } finally {
          await client.close();
        }
      };
      const listed = (await asB('list_targets', {})).structuredContent as { targets: TargetOut[] };
      expect(listed.targets).toEqual([]);
      const jobs = (await asB('list_jobs', { targetId: made.target.id })).structuredContent as {
        jobs: unknown[];
      };
      expect(jobs.jobs).toEqual([]);
      // The same name for B is a separate Target, and A's stays as it was.
      const edited = (await asB('upsert_target', { name: 'mine', criteria: { keywords: ['x'] } }))
        .structuredContent as { target: TargetOut };
      expect(edited.target.id).not.toBe(made.target.id);
      const again = (await call('list_targets', {})).structuredContent as { targets: TargetOut[] };
      expect(again.targets.find((t) => t.id === made.target.id)?.criteria.keywords).toEqual([
        'alpha',
      ]);
    });

    it("list_jobs by Target returns only that Target's candidates, rematched at once on upsert", async () => {
      const made = (
        await call('upsert_target', { name: 'empty', criteria: { keywords: ['zzzunmatched'] } })
      ).structuredContent as { target: TargetOut };
      const out = (await call('list_jobs', { targetId: made.target.id })).structuredContent as {
        jobs: unknown[];
        nextCursor: string | null;
      };
      expect(out).toEqual({ jobs: [], nextCursor: null });
    });
  });
});
