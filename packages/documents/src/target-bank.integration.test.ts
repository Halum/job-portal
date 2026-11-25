import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { DocumentsError, createDocuments, type Documents } from './documents';
import { documentsMigrations } from './index';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TARGET = '00000000-0000-4000-8000-0000000000a1';
const TARGET_2 = '00000000-0000-4000-8000-0000000000a2';
const OTHERS_TARGET = '00000000-0000-4000-8000-0000000000b1';
const UNKNOWN = '00000000-0000-4000-8000-000000000999';

const work = {
  role: 'Koch',
  organisation: 'Muster Küche GmbH',
  start: '2020-03',
  end: null,
  place: null,
};
const point = (text: string) => ({ text, skills: ['kochen'] });

describe('Target career banks through the Documents interface', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let docs: Documents;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [documentsMigrations]);
    handle = createDb(container.getConnectionUri());
    const owned = new Map([
      [TARGET, USER],
      [TARGET_2, USER],
      [OTHERS_TARGET, OTHER],
    ]);
    docs = createDocuments(handle.db, {
      hasTarget: (userId, targetId) => Promise.resolve(owned.get(targetId) === userId),
    });
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
  const set = (
    userId: string,
    input: Omit<Parameters<Documents['setOverride']>[1], 'reason' | 'actor'>,
  ) => docs.setOverride(userId, { reason: 'user_edit', actor: 'user', ...input });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (err) {
      return err instanceof DocumentsError ? err.code : 'other error';
    }
  };
  const view = async (userId = USER, targetId = TARGET) =>
    (await docs.getTargetCareerBank(userId, targetId)).workExperiences;

  it('hides, replaces and adds for one Target and leaves the Career bank and other Targets alone', async () => {
    const job = await add(USER, 'work_experience', work);
    const a = await add(USER, 'experience_point', point('Kochte 80 Essen'), job.id);
    const b = await add(USER, 'experience_point', point('Schulte zwei Azubis'), job.id);
    const c = await add(USER, 'experience_point', point('Reinigte die Küche'), job.id);

    await set(USER, { targetId: TARGET, action: 'hide', itemId: a.id });
    await set(USER, {
      targetId: TARGET,
      action: 'replace',
      itemId: b.id,
      value: point('Leitete zwei Azubis an'),
    });
    const added = await set(USER, {
      targetId: TARGET,
      action: 'add',
      itemKind: 'experience_point',
      parentId: job.id,
      value: point('Nur für dieses Ziel'),
    });

    const points = (await view())[0]?.points.map((p) => [p.id, p.source]);
    expect(points).toEqual([
      [a.id, 'hidden'],
      [b.id, 'replaced'],
      [c.id, 'inherited'],
      [added.id, 'added'],
    ]);
    expect((await view())[0]?.points[1]).toMatchObject({
      text: 'Leitete zwei Azubis an',
      stale: false,
    });

    const bank = await docs.getCareerBank(USER);
    expect(bank.workExperiences[0]?.points.map((p) => [p.id, p.text])).toEqual([
      [a.id, 'Kochte 80 Essen'],
      [b.id, 'Schulte zwei Azubis'],
      [c.id, 'Reinigte die Küche'],
    ]);
    expect((await view(USER, TARGET_2))[0]?.points.map((p) => p.source)).toEqual([
      'inherited',
      'inherited',
      'inherited',
    ]);
  });

  it('flags a replacement stale after the Career bank item changes, and a new set makes it current again', async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('Alt'), job.id);
    await set(USER, {
      targetId: TARGET_2,
      action: 'replace',
      itemId: p.id,
      value: point('Ziel-Text'),
    });
    expect((await view(USER, TARGET_2)).at(-1)?.points[0]).toMatchObject({ stale: false });

    await docs.upsertItem(USER, {
      itemKind: 'experience_point',
      itemId: p.id,
      value: point('Neu in der Bank'),
      reason: 'user_edit',
      actor: 'user',
    });
    const stale = (await view(USER, TARGET_2)).at(-1)?.points[0];
    expect(stale).toMatchObject({ text: 'Ziel-Text', source: 'replaced', stale: true });

    await set(USER, {
      targetId: TARGET_2,
      action: 'replace',
      itemId: p.id,
      value: point('Ziel-Text 2'),
    });
    expect((await view(USER, TARGET_2)).at(-1)?.points[0]).toMatchObject({
      text: 'Ziel-Text 2',
      stale: false,
    });
  });

  it('writes a revision of item kind override for every set, change and clear', async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('Text'), job.id);
    const first = await set(USER, { targetId: TARGET, action: 'hide', itemId: p.id });
    const second = await set(USER, {
      targetId: TARGET,
      action: 'replace',
      itemId: p.id,
      value: point('Anders'),
    });
    expect(second.id).toBe(first.id);
    await docs.clearOverride(USER, first.id, 'user');

    const revisions = await docs.listRevisions(USER, first.id);
    expect(revisions.map((r) => [r.itemKind, r.reason, r.oldValue === null, r.actor])).toEqual([
      ['override', 'user_edit', true, 'user'],
      ['override', 'user_edit', false, 'user'],
      ['override', 'restore', false, 'user'],
    ]);
    expect(revisions[1]?.newValue).toMatchObject({
      targetId: TARGET,
      action: 'replace',
      itemId: p.id,
      value: point('Anders'),
    });
    expect(
      (await view()).find((w) => w.id === job.id)?.points.find((x) => x.id === p.id)?.source,
    ).toBe('inherited');
  });

  it('adds under a Target-only Work experience and refuses a missing, wrong or foreign parent', async () => {
    const job = await add(USER, 'work_experience', work);
    const section = await add(USER, 'outline_section', { name: 'Einleitung' });
    const only = await set(USER, {
      targetId: TARGET,
      action: 'add',
      itemKind: 'work_experience',
      value: { ...work, role: 'Barista' },
    });
    const under = await set(USER, {
      targetId: TARGET,
      action: 'add',
      itemKind: 'experience_point',
      parentId: only.id,
      value: point('Latte Art'),
    });
    const added = (await view()).find((w) => w.id === only.id);
    expect(added).toMatchObject({ role: 'Barista', source: 'added' });
    expect(added?.points.map((p) => p.id)).toEqual([under.id]);

    const base = {
      targetId: TARGET,
      action: 'add' as const,
      itemKind: 'experience_point' as const,
      value: point('x'),
    };
    expect(await code(set(USER, base))).toBe('invalid_argument');
    expect(await code(set(USER, { ...base, parentId: section.id }))).toBe('not_found');
    expect(await code(set(USER, { ...base, parentId: UNKNOWN }))).toBe('not_found');
    const foreignJob = await add(OTHER, 'work_experience', work);
    expect(await code(set(USER, { ...base, parentId: foreignJob.id }))).toBe('not_found');
    expect(
      await code(
        set(USER, {
          targetId: TARGET,
          action: 'add',
          itemKind: 'resume_entry',
          parentId: job.id,
          value: { kind: 'skill', name: 'x' },
        }),
      ),
    ).toBe('invalid_argument');
  });

  it('types the value with the item kind schema and refuses a wrong kind or shape', async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('T'), job.id);
    expect(
      await code(
        set(USER, {
          targetId: TARGET,
          action: 'replace',
          itemId: p.id,
          value: { text: '', skills: [] },
        }),
      ),
    ).toBe('invalid_argument');
    expect(
      await code(
        set(USER, {
          targetId: TARGET,
          action: 'replace',
          itemId: p.id,
          itemKind: 'work_experience',
          value: work,
        }),
      ),
    ).toBe('invalid_argument');
    expect(await code(set(USER, { targetId: TARGET, action: 'replace', itemId: p.id }))).toBe(
      'invalid_argument',
    );
    expect(
      await code(set(USER, { targetId: TARGET, action: 'hide', itemId: p.id, value: point('x') })),
    ).toBe('invalid_argument');
    expect(await code(set(USER, { targetId: TARGET, action: 'add', value: point('x') }))).toBe(
      'invalid_argument',
    );
    expect(await code(set(USER, { targetId: TARGET, action: 'hide' }))).toBe('invalid_argument');
    const style = await add(USER, 'writing_style', {
      tone: 'a',
      sentenceNotes: 'b',
      wordsUsed: [],
      wordsAvoided: [],
      salutation: 'c',
      signOff: 'd',
    });
    expect(await code(set(USER, { targetId: TARGET, action: 'hide', itemId: style.id }))).toBe(
      'invalid_argument',
    );
  });

  it("refuses a foreign or unknown Target and another user's item or override", async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('T'), job.id);
    const mine = await set(USER, { targetId: TARGET, action: 'hide', itemId: p.id });

    expect(await code(set(USER, { targetId: OTHERS_TARGET, action: 'hide', itemId: p.id }))).toBe(
      'not_found',
    );
    expect(await code(set(USER, { targetId: UNKNOWN, action: 'hide', itemId: p.id }))).toBe(
      'not_found',
    );
    expect(await code(docs.getTargetCareerBank(USER, OTHERS_TARGET))).toBe('not_found');
    expect(await code(docs.getTargetCareerBank(USER, UNKNOWN))).toBe('not_found');
    expect(await code(set(OTHER, { targetId: OTHERS_TARGET, action: 'hide', itemId: p.id }))).toBe(
      'not_found',
    );
    expect(await code(set(USER, { targetId: TARGET, action: 'hide', itemId: UNKNOWN }))).toBe(
      'not_found',
    );
    expect(await code(docs.clearOverride(OTHER, mine.id, 'user'))).toBe('not_found');
    expect(await code(docs.clearOverride(USER, UNKNOWN, 'user'))).toBe('not_found');
    expect(await code(docs.listRevisions(OTHER, mine.id))).toBe('not_found');
    expect(
      (await view()).find((w) => w.id === job.id)?.points.find((x) => x.id === p.id)?.source,
    ).toBe('hidden');
  });

  it('leaves out an item the Career bank hid, even when a Target replaced it', async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('T'), job.id);
    await set(USER, { targetId: TARGET_2, action: 'replace', itemId: p.id, value: point('R') });
    await docs.hideItem(USER, p.id, 'user');
    const ids = (await view(USER, TARGET_2)).flatMap((w) => w.points.map((x) => x.id));
    expect(ids).not.toContain(p.id);
  });

  it('refuses a hide or replace of an item the Career bank itself hid', async () => {
    const job = await add(USER, 'work_experience', work);
    const p = await add(USER, 'experience_point', point('T'), job.id);
    await docs.hideItem(USER, p.id, 'user');
    expect(await code(set(USER, { targetId: TARGET, action: 'hide', itemId: p.id }))).toBe(
      'invalid_argument',
    );
    expect(
      await code(
        set(USER, { targetId: TARGET, action: 'replace', itemId: p.id, value: point('R') }),
      ),
    ).toBe('invalid_argument');
  });

  it('edits an added item in place with overrideId and keeps its id', async () => {
    const job = await add(USER, 'work_experience', work);
    const first = await set(USER, {
      targetId: TARGET_2,
      action: 'add',
      itemKind: 'experience_point',
      parentId: job.id,
      value: point('v1'),
    });
    const again = await set(USER, {
      targetId: TARGET_2,
      action: 'add',
      overrideId: first.id,
      itemKind: 'experience_point',
      parentId: job.id,
      value: point('v2'),
    });
    expect(again.id).toBe(first.id);
    const shown = (await view(USER, TARGET_2))
      .find((w) => w.id === job.id)
      ?.points.filter((p) => p.source === 'added');
    expect(shown?.map((p) => p.text)).toEqual(['v2']);
    expect(
      await code(
        set(OTHER, {
          targetId: OTHERS_TARGET,
          action: 'add',
          overrideId: first.id,
          itemKind: 'experience_point',
          parentId: job.id,
          value: point('x'),
        }),
      ),
    ).toBe('not_found');
  });

  it('clears the points added under a Target-only Work experience together with it', async () => {
    const only = await set(USER, {
      targetId: TARGET_2,
      action: 'add',
      itemKind: 'work_experience',
      value: { ...work, role: 'Bäcker' },
    });
    const under = await set(USER, {
      targetId: TARGET_2,
      action: 'add',
      itemKind: 'experience_point',
      parentId: only.id,
      value: point('Brot'),
    });
    await docs.clearOverride(USER, only.id, 'user');
    expect((await view(USER, TARGET_2)).some((w) => w.id === only.id)).toBe(false);
    expect((await docs.listRevisions(USER, under.id)).map((r) => r.reason)).toEqual([
      'user_edit',
      'restore',
    ]);
    expect(await code(docs.clearOverride(USER, under.id, 'user'))).toBe('not_found');
  });

  it('refuses every Target call when no Target lookup is wired', async () => {
    const bare = createDocuments(handle.db);
    expect(await code(bare.getTargetCareerBank(USER, TARGET))).toBe('not_found');
  });
});
