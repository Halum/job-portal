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
const UNKNOWN = '00000000-0000-4000-8000-000000000997';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('Documents through the API', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: Server;
  let base: string;
  let documents: Documents;
  let userId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), allMigrations);
    handle = createDb(container.getConnectionUri());
    const accounts = createAccounts(handle.db, TOKEN);
    userId = (await accounts.seedUser('user@example.invalid')).id;
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

  interface Item {
    id: string;
    hidden: boolean;
    value: Record<string, unknown>;
    [key: string]: unknown;
  }
  interface Revision {
    id: string;
    reason: string;
    actor: string;
    oldValue: unknown;
    newValue: unknown;
  }
  interface Bank {
    workExperiences: (Item & { points: Item[] })[];
    resumeEntries: Item[];
    coverLetterOutline: (Item & { paragraphs: Item[] })[];
    writingStyle: Item;
    contact: Item;
  }
  const at = <T>(xs: T[], i = 0): T => {
    const x = xs[i];
    if (x === undefined) throw new Error(`no item at ${String(i)}`);
    return x;
  };
  /** What a tool answers; a field is only there for the tool that returns it. */
  type Out = { item: Item; revisions: Revision[] } & Bank;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? '';
    return { isError: r.isError === true, out: r.structuredContent as Out, text };
  };
  const upsert = (itemKind: string, value: Record<string, unknown>, more = {}) =>
    call('upsert_career_item', { itemKind, value, reason: 'user_edit', ...more });
  const itemId = (r: { out: Out }): string => r.out.item.id;
  const bank = async () => (await call('get_career_bank')).out;

  const entry = (kind: string, rest: Record<string, unknown>) => ({ kind, ...rest });
  const education = entry('education', {
    institution: 'Musterstadt Universität',
    degree: 'B.Sc. Informatik',
    start: '2015',
    end: '2018',
    place: 'Musterstadt',
  });
  const paragraph = {
    text: 'Ich koche gern für viele Gäste.',
    themes: ['Teamarbeit'],
    skills: ['kochen'],
  };
  const style = {
    tone: 'sachlich und freundlich',
    sentenceNotes: 'kurze Sätze',
    wordsUsed: ['gern'],
    wordsAvoided: ['leidenschaftlich'],
    salutation: 'Guten Tag',
    signOff: 'Mit freundlichen Grüßen',
  };
  const contact = {
    name: 'Erika Beispiel',
    address: 'Musterweg 1, 12345 Musterstadt',
    phone: '+49 000 0000000',
    email: 'erika@example.invalid',
    links: ['https://example.invalid/erika'],
    photoFileId: null,
  };

  it('registers the item tools', async () => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'upsert_career_item',
        'hide_career_item',
        'restore_career_item',
        'list_career_revisions',
      ]),
    );
  });

  it('imports every item kind and reads them back', async () => {
    const r = await call('save_career_bank', {
      workExperiences: [
        {
          role: 'Koch',
          organisation: 'Muster Küche GmbH',
          start: '2020-03',
          end: null,
          place: null,
          points: [{ text: 'Plante die Speisekarte', skills: ['kochen'] }],
        },
      ],
      resumeEntries: [
        education,
        entry('skill', { name: 'HACCP' }),
        entry('language', { name: 'Deutsch', level: 'C1' }),
        entry('certificate', { name: 'Hygieneschulung', issuer: 'Muster IHK', date: '2022-05' }),
      ],
      coverLetterOutline: [
        { name: 'Einstieg', paragraphs: [paragraph] },
        { name: 'Schluss', paragraphs: [] },
      ],
      writingStyle: style,
      contact,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.out).toEqual({
      workExperiences: 1,
      experiencePoints: 1,
      resumeEntries: 4,
      outlineSections: 2,
      coverLetterParagraphs: 1,
      writingStyle: true,
      contact: true,
    });
    const b = await bank();
    expect(b.resumeEntries.map((e) => e.kind)).toEqual([
      'education',
      'skill',
      'language',
      'certificate',
    ]);
    expect(b.resumeEntries[0]).toMatchObject({ ...education, hidden: false });
    expect(b.coverLetterOutline.map((s) => s.name)).toEqual(['Einstieg', 'Schluss']);
    expect(at(at(b.coverLetterOutline).paragraphs)).toMatchObject({ ...paragraph, hidden: false });
    expect(b.writingStyle).toMatchObject(style);
    expect(b.contact).toMatchObject(contact);
  });

  it('refuses an import with nothing in it, and a second Writing style import updates the one', async () => {
    expect((await call('save_career_bank', {})).isError).toBe(true);
    const r = await call('save_career_bank', { writingStyle: { ...style, tone: 'locker' } });
    expect(r.isError, r.text).toBe(false);
    const b = await bank();
    expect(b.writingStyle.tone).toBe('locker');
    const revisions = await call('list_career_revisions', { itemId: b.writingStyle.id });
    expect(revisions.out.revisions.map((x) => x.reason)).toEqual(['import', 'import']);
  });

  it('adds an Experience point under a Work experience and edits it with a revision', async () => {
    const job = at((await bank()).workExperiences);
    const created = await upsert(
      'experience_point',
      { text: 'Schulte Azubis', skills: ['führen'] },
      {
        parentId: job.id,
        reason: 'enrichment',
      },
    );
    expect(created.isError, created.text).toBe(false);
    const id = itemId(created);
    expect(at((await bank()).workExperiences).points.map((p) => p.id)).toEqual([
      at(job.points).id,
      id,
    ]);

    const edited = await upsert(
      'experience_point',
      { text: 'Schulte drei Azubis', skills: ['führen'] },
      {
        itemId: id,
        reason: 'coaching',
        actor: 'user',
      },
    );
    expect(edited.isError, edited.text).toBe(false);
    const { revisions } = (await call('list_career_revisions', { itemId: id })).out;
    expect(revisions).toEqual([
      expect.objectContaining({ reason: 'enrichment', actor: 'skill', oldValue: null }),
      expect.objectContaining({
        reason: 'coaching',
        actor: 'user',
        oldValue: { text: 'Schulte Azubis', skills: ['führen'] },
        newValue: { text: 'Schulte drei Azubis', skills: ['führen'] },
      }),
    ]);
  });

  it('adds a Work experience, a Resume entry of each kind, a section and a paragraph', async () => {
    const we = await upsert('work_experience', {
      role: 'Küchenhilfe',
      organisation: 'Muster Küche GmbH',
      start: '2019',
      end: '2020-02',
      place: null,
    });
    expect(we.isError, we.text).toBe(false);
    for (const e of [
      entry('skill', { name: 'Knife skills' }),
      entry('language', { name: 'Englisch', level: null }),
      entry('certificate', { name: 'Erste Hilfe', issuer: null, date: null }),
    ]) {
      expect((await upsert('resume_entry', e)).isError).toBe(false);
    }
    const section = await upsert('outline_section', { name: 'Motivation' });
    const para = await upsert('cover_letter_paragraph', paragraph, { parentId: itemId(section) });
    expect(para.isError, para.text).toBe(false);
    const b = await bank();
    expect(b.workExperiences.map((w) => w.role)).toEqual(['Koch', 'Küchenhilfe']);
    expect(b.coverLetterOutline.map((s) => s.name)).toEqual(['Einstieg', 'Schluss', 'Motivation']);
  });

  it('keeps one Writing style and one set of contact details, and sets the photo by file id', async () => {
    const before = (await bank()).writingStyle.id;
    const again = await upsert('writing_style', style);
    expect(itemId(again)).toBe(before);

    const photo = (await (
      await fetch(`${base}/files?kind=photo&filename=foto.png`, {
        method: 'POST',
        headers: auth,
        body: PNG,
      })
    ).json()) as { id: string };
    const set = await upsert('contact', { ...contact, photoFileId: photo.id });
    expect(set.isError, set.text).toBe(false);
    expect((await bank()).contact.photoFileId).toBe(photo.id);

    const resume = await documents.storeFile(OTHER_USER, {
      kind: 'photo',
      filename: 'x.png',
      bytes: PNG,
    });
    const notPhoto = await documents.storeFile(userId, {
      kind: 'master_resume',
      filename: 'cv.md',
      bytes: Buffer.from('# Lebenslauf'),
    });
    const refusals = await Promise.all(
      [resume.id, notPhoto.id, UNKNOWN].map((photoFileId) =>
        upsert('contact', { ...contact, photoFileId }),
      ),
    );
    expect(refusals.map((r) => r.isError)).toEqual([true, true, true]);
  });

  it('refuses a value that does not fit its kind, a missing or wrong parent and a changed kind', async () => {
    const b = await bank();
    const job = at(b.workExperiences).id;
    const section = at(b.coverLetterOutline).id;
    const point = at(at(b.workExperiences).points).id;
    const bad: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['resume_entry', { kind: 'education', institution: 'x' }, {}],
      [
        'resume_entry',
        entry('language', { name: 'Deutsch', level: 'C1', extra: 1 }),
        { itemId: UNKNOWN },
      ],
      [
        'cover_letter_paragraph',
        { ...paragraph, themes: Array(21).fill('t') },
        { parentId: section },
      ],
      ['cover_letter_paragraph', paragraph, {}],
      ['cover_letter_paragraph', paragraph, { parentId: job }],
      ['experience_point', { text: 'x', skills: [] }, { parentId: section }],
      [
        'work_experience',
        { role: 'x', organisation: 'y', start: '2020', end: null, place: null },
        { parentId: job },
      ],
      ['contact', { ...contact, links: ['javascript:alert(1)'] }, {}],
      ['writing_style', { ...style, tone: '' }, {}],
      ['experience_point', { text: 'x', skills: [] }, { itemId: job }],
      ['experience_point', { text: 'x', skills: [] }, { itemId: point, parentId: section }],
    ];
    for (const [kind, value, more] of bad) {
      const r = await upsert(kind, value, more);
      expect(r.isError, `${kind} ${JSON.stringify(value).slice(0, 60)}`).toBe(true);
    }
  });

  it('hides an item with a revision, keeps it listed as hidden and still lets it be edited', async () => {
    const point = at(at((await bank()).workExperiences).points);
    const hidden = await call('hide_career_item', { itemId: point.id });
    expect(hidden.isError, hidden.text).toBe(false);
    expect(hidden.out.item).toMatchObject({ id: point.id, hidden: true });
    expect(at(at((await bank()).workExperiences).points)).toMatchObject({
      id: point.id,
      hidden: true,
    });
    expect((await call('hide_career_item', { itemId: point.id })).isError).toBe(true);
    expect(
      (await call('hide_career_item', { itemId: (await bank()).writingStyle.id })).isError,
    ).toBe(true);

    expect(
      (
        await upsert(
          'experience_point',
          { text: 'Plante das Menü', skills: [] },
          { itemId: point.id },
        )
      ).isError,
    ).toBe(false);
    const { revisions } = (await call('list_career_revisions', { itemId: point.id })).out;
    expect(revisions.map((r) => r.reason)).toEqual(['import', 'hide', 'user_edit']);
  });

  it('restores a hidden item, and restores earlier text as a new revision', async () => {
    const point = at(at((await bank()).workExperiences).points);
    expect((await call('restore_career_item', { itemId: point.id })).out.item).toMatchObject({
      hidden: false,
    });
    expect((await call('restore_career_item', { itemId: point.id })).isError).toBe(true);

    const { revisions } = (await call('list_career_revisions', { itemId: point.id })).out;
    const first = at(revisions);
    const back = await call('restore_career_item', {
      itemId: point.id,
      revisionId: first.id,
      actor: 'user',
    });
    expect(back.isError, back.text).toBe(false);
    expect(back.out.item.value).toEqual({ text: 'Plante die Speisekarte', skills: ['kochen'] });
    const after = (await call('list_career_revisions', { itemId: point.id })).out.revisions;
    expect(after.map((r) => r.reason)).toEqual([
      'import',
      'hide',
      'user_edit',
      'restore',
      'restore',
    ]);
    expect(after[4]).toMatchObject({ actor: 'user', newValue: { text: 'Plante die Speisekarte' } });

    const other = at(at((await bank()).workExperiences).points, 1).id;
    expect(
      (await call('restore_career_item', { itemId: other, revisionId: first.id })).isError,
    ).toBe(true);
  });

  it("refuses another user's items and parents like unknown ids", async () => {
    const wx = await documents.importCareerBank(
      OTHER_USER,
      {
        workExperiences: [
          {
            role: 'Fremd',
            organisation: 'Y',
            start: '2020',
            end: null,
            place: null,
            points: [{ text: 'f', skills: [] }],
          },
        ],
        resumeEntries: [],
        coverLetterOutline: [
          { name: 'Fremd', paragraphs: [{ text: 'f', themes: [], skills: [] }] },
        ],
      },
      'skill',
    );
    expect(wx.workExperiences).toBe(1);
    const foreign = await documents.getCareerBank(OTHER_USER);
    const fJob = foreign.workExperiences[0];
    const fPoint = fJob?.points[0];
    const fSection = foreign.coverLetterOutline[0];
    const fPara = fSection?.paragraphs[0];
    if (!fJob || !fPoint || !fSection || !fPara) throw new Error('foreign bank missing');
    const point = { text: 'x', skills: [] };
    const attempts = (a: string, b: string, c: string, d: string) => [
      upsert('experience_point', point, { parentId: a }),
      upsert('cover_letter_paragraph', paragraph, { parentId: b }),
      upsert('experience_point', point, { itemId: c }),
      call('hide_career_item', { itemId: c }),
      call('restore_career_item', { itemId: c }),
      call('restore_career_item', { itemId: d, revisionId: UNKNOWN }),
      call('list_career_revisions', { itemId: c }),
    ];
    const foreignResults = await Promise.all(attempts(fJob.id, fSection.id, fPoint.id, fPara.id));
    const unknownResults = await Promise.all(attempts(UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN));
    expect(foreignResults.map((r) => r.isError)).toEqual(Array(7).fill(true));
    expect(foreignResults.map((r) => r.text)).toEqual(unknownResults.map((r) => r.text));
    expect((await documents.getCareerBank(OTHER_USER)).workExperiences[0]?.points[0]?.hidden).toBe(
      false,
    );
  });

  it('refuses to restore a revision of another item of the same user', async () => {
    const b = await bank();
    const a = at(at(b.workExperiences).points).id;
    const c = at(at(b.workExperiences).points, 1).id;
    const rev = at((await call('list_career_revisions', { itemId: c })).out.revisions);
    expect((await call('restore_career_item', { itemId: a, revisionId: rev.id })).isError).toBe(
      true,
    );
  });
});
