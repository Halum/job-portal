import { crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createAccounts } from '@job-portal/accounts';
import { createAiLog } from '@job-portal/ai';
import { createWatchlist } from '@job-portal/boards';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery } from '@job-portal/discovery';
import { createDocuments, type Documents } from '@job-portal/documents';
import { allMigrations } from '@job-portal/migrations';
import { createMatching } from '@job-portal/matching';
import { createPipeline } from '@job-portal/pipeline';
import { createReview } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker } from '@job-portal/tracker';
import { createApiServer } from './server';

const TOKEN = 'placeholder-token-for-tests';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';

const RESUME_MD = '# Erika Beispiel\n\nKoch bei der Muster Küche GmbH, 2020 bis 2024.\n';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

/** A one-entry stored zip, enough to look like a DOCX (or like a zip that is not one). */
function zip(entryName: string): Buffer {
  const name = Buffer.from(entryName);
  const data = Buffer.from('<w:document/>');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralStart = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

describe('Documents through the API', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let base: string;
  let documents: Documents;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    await accounts.seedUser('user@example.invalid');
    const discovery = createDiscovery(handle.db, []);
    documents = createDocuments(handle.db);
    server = createApiServer({
      accounts,
      documents,
      review: createReview(handle.db),
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await handle.close();
    await container.stop();
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const upload = (kind: string, filename: string, body: Uint8Array | string, headers = auth) =>
    fetch(`${base}/files?kind=${kind}&filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers,
      body,
    });

  describe('file routes', () => {
    it('stores an uploaded Master resume and returns the same bytes', async () => {
      const res = await upload('master_resume', 'lebenslauf.md', RESUME_MD);
      expect(res.status).toBe(201);
      const info = (await res.json()) as Record<string, unknown>;
      expect(info).toMatchObject({
        kind: 'master_resume',
        filename: 'lebenslauf.md',
        mediaType: 'text/markdown',
        size: Buffer.byteLength(RESUME_MD),
      });

      const back = await fetch(`${base}/files/${String(info.id)}`, { headers: auth });
      expect(back.status).toBe(200);
      expect(back.headers.get('content-type')).toBe('text/markdown');
      expect(await back.text()).toBe(RESUME_MD);
    });

    it('accepts PDF, DOCX and plain text for the Master files and PNG or JPEG for the photo', async () => {
      const cases: [string, string, Uint8Array | string, string][] = [
        ['master_resume', 'cv.pdf', PDF, 'application/pdf'],
        [
          'master_cover_letter',
          'brief.docx',
          zip('word/document.xml'),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
        ['master_cover_letter', 'brief.txt', 'Sehr geehrte Damen und Herren', 'text/plain'],
        ['photo', 'foto.png', PNG, 'image/png'],
        ['photo', 'foto.jpg', JPEG, 'image/jpeg'],
      ];
      for (const [kind, filename, body, mediaType] of cases) {
        const res = await upload(kind, filename, body);
        expect(res.status, filename).toBe(201);
        expect(((await res.json()) as { mediaType: string }).mediaType).toBe(mediaType);
      }
    });

    it('checks the type from the content, not from the name or the kind', async () => {
      const refused: [string, string, Uint8Array | string][] = [
        ['master_resume', 'cv.pdf', Buffer.from([0x00, 0x01, 0x02, 0x03])],
        ['master_resume', 'cv.docx', zip('notes/readme.txt')],
        ['master_resume', 'cv.md', Buffer.from([0xff, 0xfe, 0x00, 0x80])],
        ['master_resume', 'cv.png', PNG],
        ['photo', 'foto.pdf', PDF],
        ['photo', 'foto.txt', 'plain text'],
      ];
      for (const [kind, filename, body] of refused) {
        expect((await upload(kind, filename, body)).status, `${kind} ${filename}`).toBe(415);
      }
    });

    it('refuses an unknown kind, a missing filename and an empty body', async () => {
      expect((await upload('passport', 'a.pdf', PDF)).status).toBe(400);
      expect(
        (await fetch(`${base}/files?kind=photo`, { method: 'POST', headers: auth, body: PNG }))
          .status,
      ).toBe(400);
      expect((await upload('master_resume', 'cv.md', '')).status).toBe(400);
    });

    it('refuses a file over 10 MB with 413', async () => {
      const res = await upload(
        'master_resume',
        'big.txt',
        Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      );
      expect(res.status).toBe(413);
    });

    it('needs the bearer token on both routes', async () => {
      expect((await upload('master_resume', 'cv.md', RESUME_MD, {} as typeof auth)).status).toBe(
        401,
      );
      const stored = await documents.storeFile(OTHER_USER, {
        kind: 'master_resume',
        filename: 'x.md',
        bytes: Buffer.from(RESUME_MD),
      });
      expect((await fetch(`${base}/files/${stored.id}`)).status).toBe(401);
    });

    it("answers 404 for another user's file, an unknown id and a wrong method", async () => {
      const stored = await documents.storeFile(OTHER_USER, {
        kind: 'master_resume',
        filename: 'x.md',
        bytes: Buffer.from(RESUME_MD),
      });
      expect((await fetch(`${base}/files/${stored.id}`, { headers: auth })).status).toBe(404);
      expect(
        (await fetch(`${base}/files/00000000-0000-4000-8000-000000000999`, { headers: auth }))
          .status,
      ).toBe(404);
      expect((await fetch(`${base}/files/not-a-uuid`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/files`, { headers: auth })).status).toBe(405);
    });
  });
});
