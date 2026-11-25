import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { DocumentsError, createDocuments, type Documents, type SavePacketInput } from './documents';
import { documentsMigrations } from './index';
import { extractPages } from './render/pdf-text';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TARGET = '00000000-0000-4000-8000-0000000000a1';
const TARGET_2 = '00000000-0000-4000-8000-0000000000a2';
const OTHERS_TARGET = '00000000-0000-4000-8000-0000000000b1';
const JOB = '00000000-0000-4000-8000-0000000000c1';
const JOB_2 = '00000000-0000-4000-8000-0000000000c2';
const OTHERS_JOB = '00000000-0000-4000-8000-0000000000d1';
const UNKNOWN = '00000000-0000-4000-8000-000000000999';

describe('Application packets through the Documents interface', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let docs: Documents;
  // The lookups the API injects: who owns which Target and Job.
  const targets = new Map([
    [TARGET, USER],
    [TARGET_2, USER],
    [OTHERS_TARGET, OTHER],
  ]);
  const jobs = new Map([
    [JOB, USER],
    [JOB_2, USER],
    [OTHERS_JOB, OTHER],
  ]);
  let experienceId: string;
  let pointIds: string[];
  let skillEntryId: string;
  let paragraphIds: string[];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [documentsMigrations]);
    handle = createDb(container.getConnectionUri());
    docs = createDocuments(handle.db, {
      hasTarget: (userId, targetId) => Promise.resolve(targets.get(targetId) === userId),
      hasJob: (userId, jobId) => Promise.resolve(jobs.get(jobId) === userId),
    });
    await docs.importCareerBank(
      USER,
      {
        workExperiences: [
          {
            role: 'Küchenhilfe',
            organisation: 'Gasthaus Zur Äpfelblüte',
            start: '2021-03',
            end: null,
            place: 'Bamberg',
            points: [
              { text: 'Gemüse und Soßen für 80 Gäste vorbereitet', skills: ['kochen'] },
              { text: 'Spülküche geführt', skills: ['teamarbeit'] },
            ],
          },
        ],
        resumeEntries: [{ kind: 'skill', name: 'Großküche' }],
        coverLetterOutline: [
          {
            name: 'Einleitung',
            paragraphs: [
              {
                text: 'mit großer Freude habe ich Ihre Anzeige gelesen.',
                themes: ['start'],
                skills: [],
              },
              { text: 'Gern überzeuge ich Sie persönlich.', themes: ['schluss'], skills: [] },
            ],
          },
        ],
      },
      'user',
    );
    const bank = await docs.getCareerBank(USER);
    const we = bank.workExperiences[0];
    experienceId = we?.id ?? '';
    pointIds = we?.points.map((p) => p.id) ?? [];
    skillEntryId = bank.resumeEntries[0]?.id ?? '';
    paragraphIds = bank.coverLetterOutline[0]?.paragraphs.map((p) => p.id) ?? [];
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (err) {
      return err instanceof DocumentsError ? err.code : 'other error';
    }
  };

  const packet = (over: Partial<SavePacketInput> = {}): SavePacketInput => ({
    jobId: JOB,
    targetId: TARGET,
    resume: {
      locale: 'de',
      header: { name: 'Mia Müller-Süß', email: 'mia@example.test', links: [] },
      experiences: [
        {
          role: 'Küchenhilfe',
          organisation: 'Gasthaus Zur Äpfelblüte',
          place: 'Bamberg',
          start: '2021-03',
          end: null,
          points: ['Gemüse und Soßen für 80 Gäste vorbereitet', 'Spülküche geführt'],
        },
      ],
      skills: ['Großküche'],
    },
    letter: {
      locale: 'de',
      sender: { name: 'Mia Müller-Süß' },
      recipient: { company: 'Brauerei Fröhlich GmbH' },
      date: '2026-11-25',
      subject: 'Bewerbung als Küchenhilfe',
      salutation: 'Sehr geehrte Damen und Herren,',
      paragraphs: ['mit großer Freude habe ich Ihre Anzeige gelesen.'],
      signOff: 'Mit freundlichen Grüßen',
      signature: 'Mia Müller-Süß',
    },
    sources: {
      resume: {
        experiences: [
          {
            itemIds: [experienceId],
            points: [{ itemIds: [pointIds[0] ?? ''] }, { itemIds: [pointIds[1] ?? ''] }],
          },
        ],
        skills: [{ itemIds: [skillEntryId] }],
      },
      letter: { paragraphs: [{ itemIds: [paragraphIds[0] ?? ''] }] },
    },
    gaps: ['Gabelstaplerschein'],
    questionsAsked: ['Hast du einen Gabelstaplerschein?'],
    ...over,
  });

  it('saves version 1 with both PDFs, page counts and over-cap flags, downloadable by file id', async () => {
    const saved = await docs.savePacket(USER, packet());
    expect(saved).toMatchObject({
      jobId: JOB,
      targetId: TARGET,
      version: 1,
      sent: false,
      resumePages: 1,
      letterPages: 1,
      resumeOverCap: false,
      letterOverCap: false,
    });
    const resume = await docs.getFile(USER, saved.resumePdfFileId);
    const letter = await docs.getFile(USER, saved.letterPdfFileId);
    expect(resume?.info.mediaType).toBe('application/pdf');
    expect((await extractPages(resume?.bytes ?? Buffer.alloc(0))).join(' ')).toContain(
      'Äpfelblüte',
    );
    expect((await extractPages(letter?.bytes ?? Buffer.alloc(0))).join(' ')).toContain(
      'Brauerei Fröhlich',
    );
    expect(await docs.getFile(OTHER, saved.resumePdfFileId)).toBeNull();
  });

  it('keeps nothing for a foreign or unknown Job, Target or source id', async () => {
    expect(await code(docs.savePacket(USER, packet({ jobId: OTHERS_JOB })))).toBe('not_found');
    expect(await code(docs.savePacket(USER, packet({ jobId: UNKNOWN })))).toBe('not_found');
    expect(await code(docs.savePacket(USER, packet({ targetId: OTHERS_TARGET })))).toBe(
      'not_found',
    );
    expect(
      await code(docs.savePacket(OTHER, packet({ jobId: OTHERS_JOB, targetId: OTHERS_TARGET }))),
    ).toBe('not_found');
  });

  it('refuses sources that are not in that Target career bank, whatever the reason', async () => {
    const hiddenForTarget = await docs.setOverride(USER, {
      targetId: TARGET_2,
      action: 'hide',
      itemId: pointIds[1] ?? '',
      reason: 'user_edit',
      actor: 'user',
    });
    expect(hiddenForTarget.action).toBe('hide');
    const withPoint = (id: string) =>
      packet({
        targetId: TARGET_2,
        sources: {
          ...packet().sources,
          resume: {
            ...packet().sources.resume,
            experiences: [
              {
                itemIds: [experienceId],
                points: [{ itemIds: [pointIds[0] ?? ''] }, { itemIds: [id] }],
              },
            ],
          },
        },
      });
    // hidden for this Target
    expect(await code(docs.savePacket(USER, withPoint(pointIds[1] ?? '')))).toBe('not_found');
    // unknown
    expect(await code(docs.savePacket(USER, withPoint(UNKNOWN)))).toBe('not_found');
    // another user's item
    const others = await docs.upsertItem(OTHER, {
      itemKind: 'resume_entry',
      value: { kind: 'skill', name: 'Fremd' },
      reason: 'user_edit',
      actor: 'user',
    });
    expect(await code(docs.savePacket(USER, withPoint(others.id)))).toBe('not_found');
    // the same packet for the Target that does not hide the point is fine
    expect(await code(docs.savePacket(USER, packet({ jobId: JOB_2 })))).toBe('resolved');
  });

  it('refuses a line count that does not match the content, and a line with no source that is not flagged new', async () => {
    const p = packet();
    expect(
      await code(
        docs.savePacket(USER, {
          ...p,
          sources: {
            ...p.sources,
            letter: {
              paragraphs: [{ itemIds: [paragraphIds[0] ?? ''] }, { itemIds: [], isNew: true }],
            },
          },
        }),
      ),
    ).toBe('invalid_argument');
    expect(
      await code(
        docs.savePacket(USER, {
          ...p,
          sources: { ...p.sources, letter: { paragraphs: [{ itemIds: [] }] } },
        }),
      ),
    ).toBe('invalid_argument');
    const flagged = await docs.savePacket(USER, {
      ...p,
      jobId: JOB_2,
      sources: { ...p.sources, letter: { paragraphs: [{ itemIds: [], isNew: true }] } },
    });
    const got = await docs.getPacket(USER, JOB_2, flagged.version);
    expect(got.sources.letter.paragraphs).toEqual([{ items: [], isNew: true }]);
  });

  it('records each source with its item, revision and override id (replaced and Target-added items)', async () => {
    const replaced = await docs.setOverride(USER, {
      targetId: TARGET,
      action: 'replace',
      itemId: pointIds[0] ?? '',
      value: { text: 'Kochte täglich für 80 Gäste', skills: ['kochen'] },
      reason: 'user_edit',
      actor: 'user',
    });
    const added = await docs.setOverride(USER, {
      targetId: TARGET,
      action: 'add',
      itemKind: 'experience_point',
      parentId: experienceId,
      value: { text: 'Bediente die Fritteuse', skills: ['kochen'] },
      reason: 'user_edit',
      actor: 'user',
    });
    const p = packet();
    const saved = await docs.savePacket(USER, {
      ...p,
      sources: {
        ...p.sources,
        resume: {
          ...p.sources.resume,
          experiences: [
            {
              itemIds: [experienceId],
              points: [
                { itemIds: [pointIds[0] ?? ''] },
                { itemIds: [added.id, pointIds[1] ?? ''] },
              ],
            },
          ],
        },
      },
    });
    const got = await docs.getPacket(USER, JOB, saved.version);
    const [first, merged] = got.sources.resume.experiences[0]?.points ?? [];
    const revisionsOf = async (id: string) => (await docs.listRevisions(USER, id)).at(-1)?.id;
    expect(first?.items).toEqual([
      {
        itemId: pointIds[0],
        kind: 'experience_point',
        source: 'replaced',
        overrideId: replaced.id,
        revisionId: await revisionsOf(pointIds[0] ?? ''),
      },
    ]);
    expect(merged?.items.map((i) => [i.itemId, i.source, i.overrideId])).toEqual([
      [added.id, 'added', added.id],
      [pointIds[1], 'inherited', null],
    ]);
    expect(merged?.items[0]?.revisionId).toBe(await revisionsOf(added.id));
    expect(got.sources.resume.experiences[0]?.items[0]?.source).toBe('inherited');
  });

  it('assigns versions per Job without gaps or repeats, also for saves at the same time', async () => {
    const job = JOB;
    const before = (await docs.listPackets(USER, job)).length;
    const saved = await Promise.all(
      [1, 2, 3, 4].map(() => docs.savePacket(USER, packet({ jobId: job }))),
    );
    expect(saved.map((s) => s.version).sort()).toEqual([1, 2, 3, 4].map((n) => before + n));
    const list = await docs.listPackets(USER, job);
    expect(list.map((s) => s.version)).toEqual(list.map((_, i) => i + 1));
    expect((await docs.packetsOverview(USER, job)).currentVersion).toBe(list.length);
  });

  it('moves the sent mark in one transaction and keeps the old one when the version is unknown', async () => {
    const job = JOB_2;
    const a = await docs.savePacket(USER, packet({ jobId: job }));
    const b = await docs.savePacket(USER, packet({ jobId: job }));
    await docs.markPacketSent(USER, job, a.version);
    expect((await docs.markPacketSent(USER, job, b.version)).sent).toBe(true);
    const sentVersions = (await docs.listPackets(USER, job))
      .filter((s) => s.sent)
      .map((s) => s.version);
    expect(sentVersions).toEqual([b.version]);
    expect(await code(docs.markPacketSent(USER, job, 999))).toBe('not_found');
    expect((await docs.packetsOverview(USER, job)).sentVersion).toBe(b.version);
    expect(await code(docs.markPacketSent(USER, OTHERS_JOB, 1))).toBe('not_found');
  });

  it('reads one version with content, Markdown and sources, the newest by default, and refuses foreign Jobs', async () => {
    const job = JOB_2;
    const list = await docs.listPackets(USER, job);
    const newest = list.at(-1);
    const got = await docs.getPacket(USER, job);
    expect(got.version).toBe(newest?.version);
    expect(got.gaps).toEqual(['Gabelstaplerschein']);
    expect(got.questionsAsked).toEqual(['Hast du einen Gabelstaplerschein?']);
    expect(got.resumeMarkdown).toContain('Äpfelblüte');
    expect(got.letterMarkdown).toContain('Brauerei Fröhlich');
    expect((await docs.getPacket(USER, job, 1)).version).toBe(1);
    expect(await code(docs.getPacket(USER, job, 999))).toBe('not_found');
    expect(await code(docs.getPacket(USER, OTHERS_JOB))).toBe('not_found');
    expect(await code(docs.getPacket(OTHER, job))).toBe('not_found');
    expect(await code(docs.listPackets(OTHER, job))).toBe('not_found');
    expect(await docs.packetsOverview(USER, UNKNOWN)).toEqual({
      count: 0,
      currentVersion: null,
      sentVersion: null,
    });
  });

  it('flags a resume over the page cap and stores it anyway', async () => {
    const p = packet();
    const points = Array.from(
      { length: 20 },
      (_, i) =>
        'Aufgabe Nummer ' +
        String(i) +
        ' mit etwas längerem Text, damit die Seite voll wird und weiter läuft.',
    );
    const long = await docs.savePacket(USER, {
      ...p,
      resume: {
        ...p.resume,
        experiences: Array.from({ length: 6 }, (_, i) => ({
          role: 'Rolle ' + String(i),
          organisation: 'Firma ' + String(i),
          start: '2021-03',
          end: null,
          points,
        })),
      },
      sources: {
        ...p.sources,
        resume: {
          ...p.sources.resume,
          experiences: Array.from({ length: 6 }, () => ({
            itemIds: [experienceId],
            points: points.map(() => ({ itemIds: [pointIds[0] ?? ''] })),
          })),
        },
      },
    });
    expect(long.resumeOverCap).toBe(true);
    expect(long.resumePages).toBeGreaterThan(2);
  });
});
