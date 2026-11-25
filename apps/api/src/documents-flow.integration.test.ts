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
import { extractPages } from '@job-portal/documents/testing';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';

// The whole Documents flow the skill walks through, over real HTTP: upload, register, import, Target override,
// save a packet, download a PDF. Synthetic person and documents only.
describe('Documents flow end to end', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let base: string;
  let client: Client;
  let userId: string;
  let matching: ReturnType<typeof createMatching>;
  let discovery: ReturnType<typeof createDiscovery>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
    discovery = createDiscovery(handle.db, []);
    matching = createMatching(handle.db, { loadJobs: (u, ids) => discovery.listMatchable(u, ids) });
    server = createApiServer({
      accounts,
      documents: createDocuments(handle.db, {
        hasTarget: async (u, id) => (await matching.listTargets(u)).some((t) => t.id === id),
        hasJob: async (u, id) => (await discovery.getJob(u, id)) !== null,
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
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
  });
  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  interface Pt {
    id: string;
    source?: string;
    overrideId?: string | null;
    text?: string;
    items?: { source: string; overrideId: string | null }[];
  }
  interface Out {
    file: { id: string };
    override: { id: string };
    workExperiences: { id: string; points: Pt[] }[];
    coverLetterOutline: { paragraphs: Pt[] }[];
    packet: {
      version: number;
      resumeOverCap: boolean;
      letterOverCap: boolean;
      resumePdfFileId: string;
      letterPdfFileId: string;
      sources: { resume: { experiences: { points: { items: Pt['items'] }[] }[] } };
    };
    job: { packets: { count: number; currentVersion: number | null; sentVersion: number | null } };
  }
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return r.structuredContent as Out;
  };

  it('uploads, registers, imports, overrides for a Target, saves a packet and downloads its PDF', async () => {
    // 1. upload the synthetic Master resume through the route and register it
    const upload = await fetch(`${base}/files?kind=master_resume&filename=resume.md`, {
      method: 'POST',
      headers: auth,
      body: '# Mia Müller-Süß\n\nKüchenhilfe bei Gasthaus Zur Äpfelblüte, 2021 bis heute.\n',
    });
    expect(upload.status).toBe(201);
    const file = (await upload.json()) as { id: string; mediaType: string };
    expect(file.mediaType).toBe('text/markdown');
    const registered = await call('register_master_document', {
      kind: 'master_resume',
      fileId: file.id,
    });
    expect(registered.file.id).toBe(file.id);

    // 2. import the reviewed parse
    await call('save_career_bank', {
      workExperiences: [
        {
          role: 'Küchenhilfe',
          organisation: 'Gasthaus Zur Äpfelblüte',
          start: '2021-03',
          end: null,
          place: 'Bamberg',
          points: [
            { text: 'Gemüse für 80 Gäste vorbereitet', skills: ['kochen'] },
            { text: 'Spülküche geführt', skills: ['teamarbeit'] },
          ],
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
      contact: {
        name: 'Mia Müller-Süß',
        address: null,
        phone: null,
        email: null,
        links: [],
        photoFileId: null,
      },
    });

    // 3. a Target that words one point its own way
    const target = (await matching.upsertTarget(userId, { name: 'kitchen' })).id;
    const bank = await call('get_career_bank');
    const experience = bank.workExperiences[0];
    if (!experience) throw new Error('the import stored no Work experience');
    const [first, second] = experience.points as { id: string }[];
    const paragraph = bank.coverLetterOutline[0]?.paragraphs[0];
    if (!paragraph) throw new Error('the import stored no paragraph');
    const override = await call('set_career_override', {
      targetId: target,
      action: 'replace',
      itemId: first?.id,
      value: { text: 'Bereitete täglich Gemüse für 80 Gäste vor', skills: ['kochen'] },
      reason: 'user_edit',
    });

    // 4. the Target view shows the replacement; save the packet from it
    const view = await call('get_career_bank', { targetId: target });
    expect(view.workExperiences[0]?.points[0]).toMatchObject({
      source: 'replaced',
      overrideId: override.override.id,
      text: 'Bereitete täglich Gemüse für 80 Gäste vor',
    });
    const job = (
      await discovery.addJob(userId, {
        title: 'Küchenhilfe',
        company: 'Brauerei Fröhlich',
        url: 'https://jobs.example.invalid/kuechenhilfe',
      })
    ).jobId;
    const saved = await call('save_application_packet', {
      jobId: job,
      targetId: target,
      resume: {
        locale: 'de',
        header: { name: 'Mia Müller-Süß' },
        experiences: [
          {
            role: 'Küchenhilfe',
            organisation: 'Gasthaus Zur Äpfelblüte',
            start: '2021-03',
            end: null,
            points: ['Bereitete täglich Gemüse für 80 Gäste vor', 'Spülküche geführt'],
          },
        ],
      },
      letter: {
        locale: 'de',
        sender: { name: 'Mia Müller-Süß' },
        recipient: { company: 'Brauerei Fröhlich' },
        date: '2026-11-25',
        subject: 'Bewerbung als Küchenhilfe',
        salutation: 'Guten Tag,',
        paragraphs: ['mit Freude habe ich Ihre Anzeige gelesen.'],
        signOff: 'Viele Grüße',
        signature: 'Mia Müller-Süß',
      },
      sources: {
        resume: {
          experiences: [
            {
              itemIds: [experience.id],
              points: [{ itemIds: [first?.id] }, { itemIds: [second?.id] }],
            },
          ],
        },
        letter: { paragraphs: [{ itemIds: [paragraph.id] }] },
      },
    });
    expect(saved.packet).toMatchObject({ version: 1, resumeOverCap: false, letterOverCap: false });

    // 5. download both PDFs through the route and read their text
    const pdf = async (id: string) => {
      const res = await fetch(`${base}/files/${id}`, { headers: auth });
      expect(res.headers.get('content-type')).toBe('application/pdf');
      return extractPages(Buffer.from(await res.arrayBuffer()));
    };
    expect((await pdf(saved.packet.resumePdfFileId)).join(' ')).toContain(
      'Bereitete täglich Gemüse',
    );
    expect((await pdf(saved.packet.letterPdfFileId)).join(' ')).toContain('Brauerei Fröhlich');

    // 6. the stored packet keeps the override as a source, and the sent mark shows in get_job
    const got = await call('get_application_packet', { jobId: job });
    expect(got.packet.sources.resume.experiences[0]?.points[0]?.items?.[0]).toMatchObject({
      source: 'replaced',
      overrideId: override.override.id,
    });
    await call('mark_packet_sent', { jobId: job, version: 1 });
    expect((await call('get_job', { jobId: job })).job.packets).toEqual({
      count: 1,
      currentVersion: 1,
      sentVersion: 1,
    });
  });
});
