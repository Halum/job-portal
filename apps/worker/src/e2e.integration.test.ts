import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiServer } from '@job-portal/api';
import { loadConfig } from '@job-portal/config';
import { createLogger } from '@job-portal/shared';
import { createFakeGmail, type FakeGmail } from '@job-portal/mail/testing';
import { composeApp, type App } from './compose';
import { startWorker, type WorkerHandle } from './worker';

// End to end: the worker as main.ts wires it (composeApp from real env settings) runs two scheduled sources and
// the Gmail poll against saved fixtures and fake services, and everything is then checked through the real MCP
// endpoint over HTTP. The only fake is the network: one fetch routes each host to its stand-in.
const TOKEN = 'placeholder-token-for-tests';
const WEBHOOK = 'http://n8n.example.invalid/hook';
const fixture = (file: string): string =>
  readFileSync(
    new URL(`../../../packages/discovery/src/sources/fixtures/${file}`, import.meta.url),
    'utf8',
  );

// The Bundesagentur answer gets one more posting: the same job as bambase's "Beispiel Stelle 1", so one rule
// merge (same company, title and city) puts two Postings into one Job.
const bundesagentur = (() => {
  const body = JSON.parse(fixture('bundesagentur-search.json')) as {
    ergebnisliste: Record<string, unknown>[];
  };
  const base = body.ergebnisliste[1] ?? {};
  body.ergebnisliste.push({
    ...base,
    stellenangebotsTitel: 'Beispiel Stelle 1 (m/w/d)',
    firma: 'Beispiel Firma A',
    referenznummer: '10002-0000000009-S',
    externeURL: 'https://jobs.example.invalid/ad/9',
  });
  return JSON.stringify(body);
})();
const bodyText = (init?: RequestInit): string => (typeof init?.body === 'string' ? init.body : '');
interface JobOut {
  id: string;
  title: string;
  postings: unknown[];
  tracking: { applicationStatus: string | null };
  timeline: { to: string; actor: string; evidence?: string }[];
  scores: { score: number; tagged: boolean }[];
}
interface RunOut {
  status: string;
  fetched: number;
  scored: number;
  aiRejections: number;
}
const bambase = fixture('bambase-jobs.html');

describe('worker cycle through the real MCP endpoint', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: App;
  let worker: WorkerHandle;
  let server: Server;
  let client: Client;
  let gmail: FakeGmail;
  const webhook: { topicId: string; kind: string; text: string }[] = [];
  const aiPrompts: string[] = [];
  /** The Job the scripted mail classifier names; set before the worker starts. */
  let appliedJobId = '';

  const aiAnswer = (prompt: string): object => {
    if (prompt.includes('You rate how well')) {
      // Koch fits, the merged "Beispiel Stelle 1" does not.
      const fits = prompt.includes('Koch (m/w/d)');
      return {
        score: fits ? 85 : 30,
        reasons: [fits ? 'kitchen role' : 'unrelated role'],
        redFlags: [],
        languages: [],
      };
    }
    if (prompt.includes('You sort a reply')) {
      return { kind: 'rejection', jobId: appliedJobId, confidence: 'high', summary: 'A refusal.' };
    }
    throw new Error('unexpected AI prompt');
  };

  const network = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname.endsWith('arbeitsagentur.de'))
      return Promise.resolve(new Response(bundesagentur));
    if (url.hostname.endsWith('bambase.de')) return Promise.resolve(new Response(bambase));
    if (url.hostname === 'openrouter.ai') {
      const { messages } = JSON.parse(bodyText(init)) as { messages: { content: string }[] };
      const prompt = messages[0]?.content ?? '';
      aiPrompts.push(prompt);
      return Promise.resolve(
        Response.json({
          model: 'vendor/model',
          choices: [{ message: { content: JSON.stringify(aiAnswer(prompt)) } }],
          usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.001 },
        }),
      );
    }
    if (url.hostname.endsWith('googleapis.com')) return gmail.fetch(input, init);
    if (url.href === WEBHOOK) {
      webhook.push(JSON.parse(bodyText(init)) as (typeof webhook)[number]);
      return Promise.resolve(new Response(''));
    }
    return Promise.reject(new Error(`no network in tests: ${url.hostname}`));
  }) as typeof fetch;

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
    return res.structuredContent as T;
  };

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    gmail = createFakeGmail([]);
    const config = loadConfig({
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      MCP_BEARER_TOKEN: TOKEN,
      LOG_LEVEL: 'error',
      BUNDESAGENTUR_INTERVAL_MINUTES: '1',
      BAMBASE_INTERVAL_MINUTES: '1',
      AI_RUNNER: 'openrouter',
      OPENROUTER_API_KEY: 'placeholder-key',
      OPENROUTER_MODEL: 'vendor/model',
      GMAIL_CLIENT_ID: 'client-id-placeholder',
      GMAIL_CLIENT_SECRET: 'client-secret-placeholder',
      GMAIL_REFRESH_TOKEN: 'refresh-token-placeholder',
      GMAIL_START_DATE: '2026-01-01',
      NOTIFY_WEBHOOK_URL: WEBHOOK,
      NOTIFY_TOPIC_ID: 'topic-placeholder',
      NOTIFY_MAX_ATTEMPTS: '1',
      NOTIFY_BACKOFF_MS: '0',
    });
    const logger = createLogger({ level: 'silent' });
    app = await composeApp(config, logger, { fetch: network });

    server = createApiServer({
      accounts: app.accounts,
      review: app.review,
      mail: app.mail,
      ...(app.notifications ? { notify: app.notifications } : {}),
      discovery: app.discovery,
      matching: app.matching,
      pipeline: app.pipeline,
      tracker: app.tracker,
      aiLog: app.aiLog,
      boards: {
        watchlist: app.watchlist,
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

    // The user's side, before the first tick: a Target, and a job applied for whose rejection is already in the inbox.
    await call('upsert_target', {
      name: 'odd minijob',
      criteria: {
        keywords: ['koch', 'beispiel stelle 1 (m/w/d)'],
        locations: ['Musterstadt'],
        radiusKm: 7,
      },
    });
    appliedJobId = (
      await call<{ jobId: string }>('add_job', {
        title: 'Lagerhelfer (m/w/d)',
        company: 'Beispiel Firma C',
        url: 'https://careers.beispielfirmac.example/1',
      })
    ).jobId;
    await call('set_status', { jobId: appliedJobId, applicationStatus: 'applied' });
    gmail.mails.push({
      id: 'reply-1',
      from: 'Hiring <hr@beispielfirmac.example>',
      subject: 'Your application',
      body: 'Dear applicant, Beispiel Firma C has decided to go with another candidate.',
      receivedAt: new Date(),
    });

    worker = await startWorker({
      redisUrl: config.redisUrl,
      pipeline: app.pipeline,
      userId: app.user.id,
      sources: app.scheduled,
      mail: app.mailSchedule,
      goneCold: { intervalMinutes: config.goneColdIntervalMinutes, run: app.goneCold.run },
      logger,
    });
  });

  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await worker.close();
    await app.close();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it('fetches, merges, prefilters, scores, sends the digest and applies the mail, all visible through MCP', async () => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const { runs } = await call<{ runs: RunOut[] }>('get_run_history');
      const { job } = await call<{ job: JobOut }>('get_job', { jobId: appliedJobId });
      if (
        runs.filter((r) => r.status === 'completed').length >= 2 &&
        job.tracking.applicationStatus === 'rejected'
      )
        break;
      if (Date.now() > deadline) throw new Error('the cycle did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }

    // Fetch and dedupe: 6 + 12 postings, one rule merge, plus the job added by hand.
    const { jobs } = await call<{ jobs: JobOut[] }>('list_jobs', { limit: 100 });
    expect(jobs).toHaveLength(18);
    const merged = jobs.find((j) => j.title === 'Beispiel Stelle 1 (m/w/d)');
    expect(merged?.postings).toHaveLength(2);
    const koch = jobs.find((j) => j.title === 'Koch (m/w/d)');

    // Prerank and score: two candidates, one tagged and one below the threshold with its Review item.
    const history = await call<{ runs: RunOut[]; aiTotals: object }>('get_run_history');
    expect(history.runs.map((r) => r.fetched).sort((x, y) => x - y)).toEqual([6, 12]);
    expect(history.runs.reduce((n, r) => n + r.scored, 0)).toBe(2);
    expect(history.runs.reduce((n, r) => n + r.aiRejections, 0)).toBe(1);
    expect(history.aiTotals).toMatchObject({ calls: 3, failures: 0 }); // two scores and one mail
    const target = (await call<{ targets: { id: string }[] }>('list_targets')).targets[0];
    const byTarget = await call<{ jobs: JobOut[] }>('list_jobs', {
      targetId: target?.id,
      minScore: 70,
    });
    expect(byTarget.jobs.map((j) => j.id)).toEqual([koch?.id]);

    // Digest to the webhook: the tagged Job is in it, the rejected one is not.
    const digests = webhook
      .filter((m) => m.kind === 'digest')
      .map((m) => m.text)
      .join('\n');
    expect(webhook.every((m) => m.topicId === 'topic-placeholder')).toBe(true);
    expect(digests).toContain('Koch (m/w/d)');
    expect(digests).toContain('kitchen role');
    expect(digests).not.toContain('Beispiel Stelle 1');

    // Gmail: the reply sets Rejected through the Timeline and one Telegram line goes out.
    const applied = await call<{ job: JobOut }>('get_job', { jobId: appliedJobId });
    expect(applied.job.timeline).toEqual([
      expect.objectContaining({ to: 'applied', actor: 'user' }),
      expect.objectContaining({ to: 'rejected', actor: 'gmail', evidence: 'gmail:reply-1' }),
    ]);
    const lines = webhook.filter((m) => m.kind === 'line');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('Rejected: Lagerhelfer (m/w/d) at Beispiel Firma C');

    // The user disagrees with the AI's rejection: the Job is tagged, and the stats record it.
    const { items } = await call<{ items: { id: string; score: number }[] }>('list_reviews', {
      kind: 'ai_fit_rejection',
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.score).toBe(30);
    await call('decide_review', { id: items[0]?.id, decision: 'disagree' });
    const detail = await call<{ job: JobOut }>('get_job', { jobId: merged?.id });
    expect(detail.job.scores[0]).toMatchObject({ score: 30, tagged: true });
    const tagged = await call<{ jobs: JobOut[] }>('list_jobs', {
      targetId: target?.id,
      tagged: true,
    });
    expect(tagged.jobs.map((j) => j.id).sort()).toEqual([koch?.id, merged?.id].sort());
    expect(await call('review_stats')).toMatchObject({
      pending: 0,
      counts: [{ kind: 'ai_fit_rejection', model: 'vendor/model', agreed: 0, disagreed: 1 }],
    });
  }, 90_000);

  it('the skill file names every tool the MCP server registers', async () => {
    const { tools } = await client.listTools();
    const skill = readFileSync(
      new URL('../../../skills/job-hunter/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name).filter((name) => !skill.includes(`\`${name}\``))).toEqual([]);
  });
});
