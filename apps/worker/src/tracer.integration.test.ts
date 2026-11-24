import { readFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAccounts } from '@job-portal/accounts';
import { createGmailClient, createMail, type Mail } from '@job-portal/mail';
import { createFakeGmail, type FakeGmail } from '@job-portal/mail/testing';
import { createAi, createAiLog, createOpenRouterRunner } from '@job-portal/ai';
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
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createApiServer } from '@job-portal/api';
import { createTracker } from '@job-portal/tracker';
import { buildNotifications } from './notifications';
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

// OpenRouter is faked at HTTP level: the real runner posts to a stand-in fetch.
const fakeOpenRouter = (() =>
  Promise.resolve(
    Response.json({
      model: 'vendor/model',
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 85,
              reasons: ['kitchen role'],
              redFlags: [],
              languages: [
                { language: 'de', required: 'required', level: 'B1', phrase: 'Deutsch B1' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.001 },
    }),
  )) as unknown as typeof fetch;

describe('Bundesagentur source to MCP list_jobs', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let handle: DbHandle;
  let worker: WorkerHandle;
  let server: Server;
  let client: Client;
  let webhook: Server;
  const digests: { topicId: string; kind: string; text: string }[] = [];
  let mail: Mail;
  let gmail: FakeGmail;
  let userId = '';
  /** The Job id the scripted mail classifier answers with; set once the run has found it. */
  let mailJobId = '';
  const fakeMailRouter = (() =>
    Promise.resolve(
      Response.json({
        model: 'vendor/model',
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: 'interview',
                jobId: mailJobId,
                confidence: 'high',
                summary: 'Invitation to a talk.',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 8, cost: 0.001 },
      }),
    )) as unknown as typeof fetch;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    await runMigrationsWithLock(pg.getConnectionUri(), allMigrations);
    handle = createDb(pg.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    const user = await accounts.seedUser('user@example.invalid');
    userId = user.id;
    const aiLog = createAiLog(handle.db);
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
      ai: createAi(
        aiLog,
        createOpenRouterRunner({
          apiKey: 'placeholder-key',
          model: 'vendor/model',
          fetch: fakeOpenRouter,
        }),
      ),
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
      criteria: {
        keywords: ['koch'],
        locations: ['Musterstadt'],
        radiusKm: 7,
        languageAbility: ['de:B2'],
      },
    });
    const tracker = createTracker(handle.db, discovery);
    const logger = createLogger({ level: 'silent' });
    // The n8n webhook is a local server: the digest goes out over real HTTP, nothing leaves the machine.
    webhook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        digests.push(JSON.parse(body) as (typeof digests)[number]);
        res.end();
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    const notifications = buildNotifications(
      handle.db,
      {
        webhookUrl: `http://127.0.0.1:${String((webhook.address() as AddressInfo).port)}/hook`,
        topicId: 'topic-placeholder',
        maxAttempts: 1,
        backoffMs: 0,
      },
      { matching, discovery, review: createReview(handle.db), log: logger },
    );
    const pipeline = createPipeline(handle.db, discovery, {
      matching,
      scoring: matching,
      ...(notifications ? { notifications } : {}),
    });

    gmail = createFakeGmail([]);
    mail = createMail(handle.db, {
      tracker,
      discovery,
      review: createReview(handle.db),
      ai: createAi(
        aiLog,
        createOpenRouterRunner({
          apiKey: 'placeholder-key',
          model: 'vendor/model',
          fetch: fakeMailRouter,
        }),
      ),
      gmail: createGmailClient({
        clientId: 'client-id-placeholder',
        clientSecret: 'client-secret-placeholder',
        refreshToken: 'refresh-token-placeholder',
        fetch: gmail.fetch,
      }),
      ...(notifications ? { notify: notifications } : {}),
      maxCallsPerPass: 5,
      log: logger,
    });

    worker = await startWorker({
      redisUrl: redis.getConnectionUrl(),
      pipeline,
      userId: user.id,
      sources: [{ sourceId: 'bundesagentur', intervalMinutes: 1 }],
      logger,
    });
    server = createApiServer({
      review: createReview(handle.db),
      mail,
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
    await new Promise((resolve) => webhook.close(resolve));
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
        scored: 1,
        tagged: 1,
        aiCalls: 1,
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

    // The AI score, its tag and the language judgement show in get_job; minScore filters list_jobs.
    expect(detail.structuredContent).toMatchObject({
      job: {
        scores: [
          {
            targetId: target?.id,
            score: 85,
            tagged: true,
            languageMet: true,
            unknownLocation: true,
            reasons: ['kitchen role'],
          },
        ],
      },
    });
    const high = (
      await client.callTool({
        name: 'list_jobs',
        arguments: { targetId: target?.id, minScore: 86 },
      })
    ).structuredContent as { jobs: unknown[] };
    expect(high.jobs).toEqual([]);
    const history = (await client.callTool({ name: 'get_run_history', arguments: {} }))
      .structuredContent as { aiTotals: { calls: number; failures: number; inputTokens: number } };
    expect(history.aiTotals).toMatchObject({ calls: 1, failures: 0, inputTokens: 50 });
  });

  it('sends one digest through the webhook for the Job the run tagged, with its link', () => {
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ topicId: 'topic-placeholder', kind: 'digest' });
    for (const part of [
      'Koch (m/w/d)',
      'odd minijob',
      '85',
      'kitchen role',
      'https://www.arbeitsagentur.de/jobsuche/jobdetail/18024-0000000002-S',
      'Review waiting: 0',
    ])
      expect(digests[0]?.text).toContain(part);
  });

  it('reads a Gmail reply for the applied Job: the status changes through the Timeline, one line goes out, and an unrelated mail is listed', async () => {
    const list = (await client.callTool({ name: 'list_jobs', arguments: {} }))
      .structuredContent as {
      jobs: { id: string; title: string }[];
    };
    mailJobId = list.jobs.find((j) => j.title === 'Koch (m/w/d)')?.id ?? '';
    await client.callTool({
      name: 'set_status',
      arguments: { jobId: mailJobId, applicationStatus: 'applied' },
    });
    gmail.mails.push(
      {
        id: 'reply-1',
        from: 'Hiring <hr@beispielfirmab.example>',
        subject: 'Invitation',
        body: 'Dear applicant, Beispiel Firma B would like to invite you for a talk.',
        receivedAt: new Date(),
      },
      {
        id: 'stray-1',
        from: 'Someone <x@nowhere.example>',
        subject: 'Your application',
        body: 'Thanks for applying.',
        receivedAt: new Date(),
      },
    );
    expect(await mail.poll(userId)).toMatchObject({ status: 'done', applied: 1, unmatched: 1 });

    const detail = await client.callTool({ name: 'get_job', arguments: { jobId: mailJobId } });
    expect(detail.structuredContent).toMatchObject({
      job: {
        tracking: { applicationStatus: 'interview' },
        timeline: [
          expect.objectContaining({ to: 'applied', actor: 'user' }),
          expect.objectContaining({ to: 'interview', actor: 'gmail', evidence: 'gmail:reply-1' }),
        ],
      },
    });
    const lines = digests.filter((d) => d.kind === 'line');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('Interview: Koch (m/w/d) at Beispiel Firma B');
    const unmatched = await client.callTool({ name: 'list_unmatched_mails', arguments: {} });
    expect(unmatched.structuredContent).toMatchObject({
      items: [expect.objectContaining({ messageId: 'stray-1' })],
    });
  });
});
