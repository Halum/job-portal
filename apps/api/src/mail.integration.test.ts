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
import { createDiscovery } from '@job-portal/discovery';
import { createGmailClient, createMail, type Mail } from '@job-portal/mail';
import { createFakeGmail } from '@job-portal/mail/testing';
import { createMatching } from '@job-portal/matching';
import { allMigrations } from '@job-portal/migrations';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

interface ReviewItemOut {
  id: string;
  kind: string;
  status: string;
  postings: { url: string }[];
  mail: {
    from: string;
    subject: string;
    summary: string;
    kind: string;
    suggestedJobId: string;
    candidateJobIds: string[];
  } | null;
}

// Gmail replies through MCP: Gmail is faked at HTTP level, the AI runner is scripted, everything else is real.
describe('Gmail replies over MCP', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let url: URL;
  let userId: string;
  let mail: Mail;
  const lines: string[] = [];
  const answers = new Map<string, object>();
  const runner: AiRunner = {
    name: 'openrouter',
    model: 'vendor/model',
    complete: (prompt) => {
      const hit = [...answers].find(([marker]) => prompt.includes(marker));
      return Promise.resolve({
        text: JSON.stringify(
          hit?.[1] ?? { kind: 'other', jobId: null, confidence: 'low', summary: '' },
        ),
        model: 'vendor/model-routed',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      });
    },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    const discovery = createDiscovery(handle.db, [
      { id: 'idle', fetch: () => Promise.resolve({ postings: [], errors: [] }) },
    ]);
    const tracker = createTracker(handle.db, discovery);
    const aiLog = createAiLog(handle.db);
    const review = createReview(handle.db);
    const matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
    });
    const notify = {
      sendLines: (_u: string, l: string[]) => {
        lines.push(...l);
        return Promise.resolve();
      },
      setFailure: () => Promise.resolve(),
    };
    const jobA = await discovery.addJob(userId, {
      title: 'Cook',
      company: 'Beispiel Firma GmbH',
      url: 'https://jobs.example.invalid/cook',
    });
    const jobB = await discovery.addJob(userId, {
      title: 'Baker',
      company: 'Muster AG',
      url: 'https://jobs.example.invalid/baker',
    });
    for (const j of [jobA, jobB]) {
      await tracker.setApplicationStatus(userId, j.jobId, {
        to: 'applied',
        actor: 'user',
        timezone: 'UTC',
      });
    }
    const now = new Date();
    const fake = createFakeGmail([
      {
        id: 'unclear-1',
        from: 'Hiring <hr@beispiel-firma.example>',
        subject: 'Next steps',
        body: 'Marker unclear-1 We would like to talk.',
        receivedAt: now,
      },
      {
        id: 'lost-1',
        from: 'Someone <x@nowhere.example>',
        subject: 'Your application',
        body: 'Marker lost-1 Thanks for applying.',
        receivedAt: now,
      },
    ]);
    answers.set('Marker unclear-1', {
      kind: 'interview',
      jobId: jobA.jobId,
      confidence: 'low',
      summary: 'Invitation to talk.',
    });
    mail = createMail(handle.db, {
      tracker,
      discovery,
      review,
      ai: createAi(aiLog, runner),
      gmail: createGmailClient({
        clientId: 'client-id-placeholder',
        clientSecret: 'client-secret-placeholder',
        refreshToken: 'refresh-token-placeholder',
        fetch: fake.fetch,
      }),
      notify,
      maxCallsPerPass: 10,
      log: createLogger({ level: 'silent' }),
    });
    const pipeline = createPipeline(handle.db, discovery, { matching });
    server = createApiServer({
      accounts,
      discovery,
      matching,
      pipeline,
      tracker,
      review,
      mail,
      notify,
      aiLog,
      boards: {
        watchlist: createWatchlist(handle.db),
        fetch: () => Promise.reject(new Error('no network in tests')),
        allowAddBoard: () => Promise.resolve(true),
      },
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`);
    expect(await mail.poll(userId)).toMatchObject({ status: 'done', review: 1, unmatched: 1 });
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

  it('list_unmatched_mails lists the job-like mail that matched nothing', async () => {
    const { out } = await call('list_unmatched_mails');
    expect(out).toEqual({
      items: [
        expect.objectContaining({
          messageId: 'lost-1',
          from: 'Someone <x@nowhere.example>',
          subject: 'Your application',
        }),
      ],
      nextCursor: null,
    });
  });

  it('list_reviews shows the mail summary and candidate postings; confirming applies it and posts one line', async () => {
    const { out } = await call('list_reviews', { kind: 'mail_match' });
    const [item] = (out as { items: ReviewItemOut[] }).items;
    expect(item).toMatchObject({
      kind: 'mail_match',
      mail: { subject: 'Next steps', summary: 'Invitation to talk.', kind: 'interview' },
    });
    expect(item?.postings.map((p) => p.url)).toEqual(['https://jobs.example.invalid/cook']);

    const decided = await call('decide_review', { id: item?.id, decision: 'confirm' });
    expect(decided.isError).toBe(false);
    expect(lines).toEqual([expect.stringContaining('Interview: Cook at Beispiel Firma GmbH')]);
    const job = await call('get_job', { jobId: item?.mail?.suggestedJobId });
    expect(job.out).toMatchObject({ job: { tracking: { applicationStatus: 'interview' } } });
  });
});
