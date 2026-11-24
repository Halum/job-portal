import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { DocumentsError, createDocuments, type Documents } from './documents';
import { documentsMigrations } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const UNKNOWN = '00000000-0000-4000-8000-000000000999';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const work = {
  role: 'Koch',
  organisation: 'Muster Küche GmbH',
  start: '2020-03',
  end: null,
  place: null,
};
const point = (text: string) => ({ text, skills: ['kochen'] });
const paragraph = { text: 'Ich koche gern.', themes: ['Teamarbeit'], skills: ['kochen'] };
const style = {
  tone: 'sachlich',
  sentenceNotes: 'kurze Sätze',
  wordsUsed: ['gern'],
  wordsAvoided: [],
  salutation: 'Guten Tag',
  signOff: 'Mit freundlichen Grüßen',
};
const contact = {
  name: 'Erika Beispiel',
  address: null,
  phone: null,
  email: 'erika@example.invalid',
  links: [],
  photoFileId: null,
};

describe('Career bank items through the Documents interface', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let docs: Documents;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [documentsMigrations]);
    handle = createDb(container.getConnectionUri());
    docs = createDocuments(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const add = (
    userId: string,
    itemKind: Parameters<Documents['upsertItem']>[1]['itemKind'],
    value: unknown,
    parentId?: string,
  ) => docs.upsertItem(userId, { itemKind, value, parentId, reason: 'user_edit', actor: 'user' });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (err) {
      return err instanceof DocumentsError ? err.code : 'other error';
    }
  };

  it('adds and edits an Experience point with a revision each time, positions in order', async () => {
    const job = await add(USER, 'work_experience', work);
    const a = await add(USER, 'experience_point', point('erster'), job.id);
    const b = await add(USER, 'experience_point', point('zweiter'), job.id);
    const edited = await docs.upsertItem(USER, {
      itemKind: 'experience_point',
      itemId: a.id,
      value: point('erster, besser'),
      reason: 'coaching',
      actor: 'skill',
    });
    expect(edited).toMatchObject({ id: a.id, parentId: job.id, hidden: false });

    const bank = await docs.getCareerBank(USER);
    const stored = bank.workExperiences.find((w) => w.id === job.id);
    expect(stored?.points.map((p) => [p.id, p.text])).toEqual([
      [a.id, 'erster, besser'],
      [b.id, 'zweiter'],
    ]);
    const history = await docs.listRevisions(USER, a.id);
    expect(history.map((r) => [r.reason, r.actor])).toEqual([
      ['user_edit', 'user'],
      ['coaching', 'skill'],
    ]);
    expect(history[1]).toMatchObject({
      oldValue: point('erster'),
      newValue: point('erster, besser'),
    });
  });

  it('refuses a parent of another user, of the wrong kind or hidden, and a value of the wrong shape', async () => {
    const foreign = await add(OTHER, 'work_experience', work);
    const section = await add(USER, 'outline_section', { name: 'Einstieg' });
    const job = await add(USER, 'work_experience', work);
    expect(await code(add(USER, 'experience_point', point('x'), foreign.id))).toBe('not_found');
    expect(await code(add(USER, 'experience_point', point('x'), UNKNOWN))).toBe('not_found');
    expect(await code(add(USER, 'experience_point', point('x'), section.id))).toBe('not_found');
    expect(await code(add(USER, 'cover_letter_paragraph', paragraph, job.id))).toBe('not_found');
    expect(await code(add(USER, 'experience_point', point('x')))).toBe('invalid_argument');
    expect(await code(add(USER, 'work_experience', work, job.id))).toBe('invalid_argument');
    expect(await code(add(USER, 'experience_point', { text: '', skills: [] }, job.id))).toBe(
      'invalid_argument',
    );
    await docs.hideItem(USER, job.id, 'user');
    expect(await code(add(USER, 'experience_point', point('x'), job.id))).toBe('invalid_argument');
  });

  it('hides with a revision, refuses to hide twice, and restores by unhiding', async () => {
    const entry = await add(USER, 'resume_entry', { kind: 'skill', name: 'HACCP' });
    const hidden = await docs.hideItem(USER, entry.id, 'user');
    expect(hidden.hidden).toBe(true);
    expect(await code(docs.hideItem(USER, entry.id, 'user'))).toBe('invalid_argument');
    expect(await code(docs.restoreItem(USER, UNKNOWN, 'user'))).toBe('not_found');
    const back = await docs.restoreItem(USER, entry.id, 'skill');
    expect(back).toMatchObject({ hidden: false, value: { kind: 'skill', name: 'HACCP' } });
    expect(await code(docs.restoreItem(USER, entry.id, 'skill'))).toBe('invalid_argument');
    expect((await docs.listRevisions(USER, entry.id)).map((r) => r.reason)).toEqual([
      'user_edit',
      'hide',
      'restore',
    ]);
  });

  it('restores earlier text as a new revision and never rewrites history', async () => {
    const section = await add(USER, 'outline_section', { name: 'Motivation' });
    const p = await add(USER, 'cover_letter_paragraph', paragraph, section.id);
    await docs.upsertItem(USER, {
      itemKind: 'cover_letter_paragraph',
      itemId: p.id,
      value: { ...paragraph, text: 'Neuer Text.' },
      reason: 'enrichment',
      actor: 'skill',
    });
    const before = await docs.listRevisions(USER, p.id);
    const first = before[0];
    if (!first) throw new Error('no revision');
    const restored = await docs.restoreItem(USER, p.id, 'user', first.id);
    expect(restored.value).toEqual(paragraph);
    const after = await docs.listRevisions(USER, p.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[after.length - 1]).toMatchObject({ reason: 'restore', actor: 'user' });

    const otherItem = await add(USER, 'outline_section', { name: 'Schluss' });
    expect(await code(docs.restoreItem(USER, otherItem.id, 'user', first.id))).toBe('not_found');
    expect(await code(docs.restoreItem(OTHER, p.id, 'user', first.id))).toBe('not_found');
  });

  it('keeps one Writing style and one set of contact details per user and refuses to hide them', async () => {
    const s1 = await add(USER, 'writing_style', style);
    const s2 = await add(USER, 'writing_style', { ...style, tone: 'locker' });
    expect(s2.id).toBe(s1.id);
    const c1 = await add(USER, 'contact', contact);
    expect((await docs.getCareerBank(USER)).writingStyle).toMatchObject({
      id: s1.id,
      tone: 'locker',
    });
    expect(await code(docs.hideItem(USER, s1.id, 'user'))).toBe('invalid_argument');
    expect(await code(docs.hideItem(USER, c1.id, 'user'))).toBe('invalid_argument');
    expect((await add(OTHER, 'writing_style', style)).id).not.toBe(s1.id);
  });

  it("checks the photo: the user's own upload of kind photo only", async () => {
    const own = await docs.storeFile(USER, { kind: 'photo', filename: 'a.png', bytes: PNG });
    const foreign = await docs.storeFile(OTHER, { kind: 'photo', filename: 'b.png', bytes: PNG });
    const resume = await docs.storeFile(USER, {
      kind: 'master_resume',
      filename: 'cv.md',
      bytes: Buffer.from('# Lebenslauf'),
    });
    const set = await add(USER, 'contact', { ...contact, photoFileId: own.id });
    expect(set.value.photoFileId).toBe(own.id);
    for (const photoFileId of [foreign.id, resume.id, UNKNOWN]) {
      expect(await code(add(USER, 'contact', { ...contact, photoFileId }))).toBe('not_found');
    }
  });

  it("refuses another user's item on every call", async () => {
    const mine = await add(USER, 'resume_entry', { kind: 'skill', name: 'Backen' });
    expect(await code(docs.hideItem(OTHER, mine.id, 'user'))).toBe('not_found');
    expect(await code(docs.restoreItem(OTHER, mine.id, 'user'))).toBe('not_found');
    expect(await code(docs.listRevisions(OTHER, mine.id))).toBe('not_found');
    expect(
      await code(
        docs.upsertItem(OTHER, {
          itemKind: 'resume_entry',
          itemId: mine.id,
          value: { kind: 'skill', name: 'x' },
          reason: 'user_edit',
          actor: 'user',
        }),
      ),
    ).toBe('not_found');
    expect(
      (await docs.getCareerBank(USER)).resumeEntries.find((e) => e.id === mine.id),
    ).toMatchObject({
      name: 'Backen',
    });
  });

  it('refuses an import with nothing in it and writes import revisions for every kind', async () => {
    const user = '00000000-0000-4000-8000-000000000003';
    expect(
      await code(
        docs.importCareerBank(
          user,
          { workExperiences: [], resumeEntries: [], coverLetterOutline: [] },
          'skill',
        ),
      ),
    ).toBe('invalid_argument');
    const counts = await docs.importCareerBank(
      user,
      {
        workExperiences: [{ ...work, points: [point('p')] }],
        resumeEntries: [{ kind: 'language', name: 'Deutsch', level: 'C1' }],
        coverLetterOutline: [{ name: 'Einstieg', paragraphs: [paragraph] }],
        writingStyle: style,
        contact,
      },
      'skill',
    );
    expect(counts).toEqual({
      workExperiences: 1,
      experiencePoints: 1,
      resumeEntries: 1,
      outlineSections: 1,
      coverLetterParagraphs: 1,
      writingStyle: true,
      contact: true,
    });
    const bank = await docs.getCareerBank(user);
    for (const id of [
      bank.resumeEntries[0]?.id,
      bank.coverLetterOutline[0]?.paragraphs[0]?.id,
      bank.contact?.id,
    ]) {
      expect((await docs.listRevisions(user, id ?? '')).map((r) => r.reason)).toEqual(['import']);
    }
  });
});
