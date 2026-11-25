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
import { createDiscovery, type Discovery } from '@job-portal/discovery';
import { createDocuments, type Documents } from '@job-portal/documents';
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

describe('Application packets through the API', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let base: string;
  let matching: Matching;
  let discovery: Discovery;
  let documents: Documents;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    discovery = createDiscovery(handle.db, []);
    matching = createMatching(handle.db, {
      loadJobs: (u, ids) => discovery.listMatchable(u, ids),
    });
    documents = createDocuments(handle.db, {
      hasTarget: async (u, targetId) =>
        (await matching.listTargets(u)).some((t) => t.id === targetId),
      hasJob: async (u, jobId) => (await discovery.getJob(u, jobId)) !== null,
    });
    server = createApiServer({
      accounts,
      documents,
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

  interface Summary {
    id: string;
    version: number;
    sent: boolean;
    resumePdfFileId: string;
    letterPdfFileId: string;
    resumePages: number;
    letterPages: number;
    resumeOverCap: boolean;
    letterOverCap: boolean;
  }
  interface Out {
    packet: Summary & {
      resumeMarkdown: string;
      letterMarkdown: string;
      gaps: string[];
      sources: { letter: { paragraphs: { items: { itemId: string; source: string }[] }[] } };
    };
    packets: Summary[];
    job: { packets: { count: number; currentVersion: number | null; sentVersion: number | null } };
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? '';
    return { isError: r.isError === true, out: r.structuredContent as Out, text };
  };

  const newJob = async (user = userId, n = 1) =>
    (
      await discovery.addJob(user, {
        title: 'Cook ' + String(n),
        company: 'Beispiel Firma ' + String(n),
        url: 'https://jobs.example.invalid/cook-' + String(n) + '-' + user.slice(-2),
      })
    ).jobId;

  const bank = async () => {
    await call('save_career_bank', {
      workExperiences: [
        {
          role: 'Küchenhilfe',
          organisation: 'Gasthaus Zur Äpfelblüte',
          start: '2021-03',
          end: null,
          place: 'Bamberg',
          points: [{ text: 'Gemüse für 80 Gäste vorbereitet', skills: ['kochen'] }],
        },
      ],
      coverLetterOutline: [
        {
          name: 'Einleitung',
          paragraphs: [
            { text: 'mit Freude habe ich Ihre Anzeige gelesen.', themes: [], skills: [] },
          ],
        },
      ],
    });
    const got = (await documents.getCareerBank(userId)).workExperiences[0];
    const letter = (await documents.getCareerBank(userId)).coverLetterOutline[0];
    return {
      experienceId: got?.id ?? '',
      pointId: got?.points[0]?.id ?? '',
      paragraphId: letter?.paragraphs[0]?.id ?? '',
    };
  };

  const args = (
    ids: { experienceId: string; pointId: string; paragraphId: string },
    jobId: string,
    targetId: string,
  ) => ({
    jobId,
    targetId,
    resume: {
      locale: 'de',
      header: { name: 'Mia Müller-Süß' },
      experiences: [
        {
          role: 'Küchenhilfe',
          organisation: 'Gasthaus Zur Äpfelblüte',
          start: '2021-03',
          end: null,
          points: ['Gemüse für 80 Gäste vorbereitet'],
        },
      ],
    },
    letter: {
      locale: 'de',
      sender: { name: 'Mia Müller-Süß' },
      recipient: { company: 'Beispiel Firma' },
      date: '2026-11-25',
      subject: 'Bewerbung',
      salutation: 'Guten Tag,',
      paragraphs: ['mit Freude habe ich Ihre Anzeige gelesen.'],
      signOff: 'Viele Grüße',
      signature: 'Mia',
    },
    sources: {
      resume: {
        experiences: [{ itemIds: [ids.experienceId], points: [{ itemIds: [ids.pointId] }] }],
      },
      letter: { paragraphs: [{ itemIds: [ids.paragraphId] }] },
    },
    gaps: ['Staplerschein'],
  });

  it('saves, lists and reads versions, downloads the PDFs, and get_job carries the summary', async () => {
    const ids = await bank();
    const target = (await matching.upsertTarget(userId, { name: 'kitchen' })).id;
    const job = await newJob();
    expect((await call('get_job', { jobId: job })).out.job.packets).toEqual({
      count: 0,
      currentVersion: null,
      sentVersion: null,
    });

    const first = await call('save_application_packet', args(ids, job, target));
    expect(first.isError).toBe(false);
    expect(first.out.packet).toMatchObject({
      version: 1,
      resumePages: 1,
      letterPages: 1,
      resumeOverCap: false,
      letterOverCap: false,
    });
    const second = await call('save_application_packet', args(ids, job, target));
    expect(second.out.packet.version).toBe(2);

    expect(
      (await call('list_application_packets', { jobId: job })).out.packets.map((p) => p.version),
    ).toEqual([1, 2]);
    const got = (await call('get_application_packet', { jobId: job })).out.packet;
    expect(got.version).toBe(2);
    expect(got.gaps).toEqual(['Staplerschein']);
    expect(got.resumeMarkdown).toContain('Äpfelblüte');
    expect(got.sources.letter.paragraphs[0]?.items[0]).toMatchObject({
      itemId: ids.paragraphId,
      source: 'inherited',
    });
    expect(
      (await call('get_application_packet', { jobId: job, version: 1 })).out.packet.version,
    ).toBe(1);

    for (const id of [got.resumePdfFileId, got.letterPdfFileId]) {
      const res = await fetch(`${base}/files/${id}`, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(500);
    }

    expect((await call('mark_packet_sent', { jobId: job, version: 1 })).out.packet.sent).toBe(true);
    await call('mark_packet_sent', { jobId: job, version: 2 });
    expect((await call('get_job', { jobId: job })).out.job.packets).toEqual({
      count: 2,
      currentVersion: 2,
      sentVersion: 2,
    });
    expect(
      (await call('list_application_packets', { jobId: job })).out.packets.map((p) => p.sent),
    ).toEqual([false, true]);
    expect((await call('mark_packet_sent', { jobId: job, version: 99 })).isError).toBe(true);
  });

  it('refuses foreign and unknown Jobs, Targets and source items on every packet tool', async () => {
    const ids = await bank();
    const target = (await matching.upsertTarget(userId, { name: 'refusals' })).id;
    const job = await newJob(userId, 2);
    const foreignJob = await newJob(OTHER_USER, 3);
    const foreignTarget = (await matching.upsertTarget(OTHER_USER, { name: 'theirs' })).id;
    const foreignItem = (
      await documents.upsertItem(OTHER_USER, {
        itemKind: 'work_experience',
        value: {
          role: 'Fremd',
          organisation: 'Fremd GmbH',
          start: '2020-01',
          end: null,
          place: null,
        },
        reason: 'user_edit',
        actor: 'user',
      })
    ).id;

    const refused = async (name: string, a: Record<string, unknown>) => {
      const r = await call(name, a);
      return r.isError;
    };
    expect(await refused('save_application_packet', args(ids, foreignJob, target))).toBe(true);
    expect(await refused('save_application_packet', args(ids, UNKNOWN, target))).toBe(true);
    expect(await refused('save_application_packet', args(ids, job, foreignTarget))).toBe(true);
    expect(
      await refused(
        'save_application_packet',
        args({ ...ids, experienceId: foreignItem }, job, target),
      ),
    ).toBe(true);
    expect(await refused('list_application_packets', { jobId: foreignJob })).toBe(true);
    expect(await refused('get_application_packet', { jobId: foreignJob })).toBe(true);
    expect(await refused('mark_packet_sent', { jobId: foreignJob, version: 1 })).toBe(true);
    // nothing was stored by the refused saves
    expect((await call('list_application_packets', { jobId: job })).out.packets).toEqual([]);
  });
});
