import { describe, expect, it } from 'vitest';
import type { CareerBank } from './documents';
import { resolveCareerBank, type CareerOverride } from './resolve';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WE = ID(1);
const POINT_A = ID(2);
const POINT_B = ID(3);
const ENTRY = ID(4);

const bank = (): CareerBank => ({
  masterDocuments: { masterResume: null, masterCoverLetter: null },
  workExperiences: [
    {
      id: WE,
      hidden: false,
      role: 'Line cook',
      organisation: 'Example Kitchen',
      start: '2020-01',
      end: null,
      place: null,
      points: [
        { id: POINT_A, hidden: false, text: 'Prepared 80 meals per shift', skills: ['cooking'] },
        { id: POINT_B, hidden: false, text: 'Trained two juniors', skills: ['teaching'] },
      ],
    },
  ],
  resumeEntries: [{ id: ENTRY, hidden: false, kind: 'skill', name: 'Knife work' }],
  coverLetterOutline: [],
  writingStyle: null,
  contact: null,
});

const override = (
  o: Partial<CareerOverride> & Pick<CareerOverride, 'id' | 'action'>,
): CareerOverride => ({
  targetId: ID(900),
  itemKind: 'experience_point',
  itemId: null,
  parentId: null,
  value: null,
  baseRevisionId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
});

describe('resolveCareerBank', () => {
  it('marks everything inherited when the Target has no overrides', () => {
    const view = resolveCareerBank(bank(), [], new Map());
    const we = view.workExperiences[0];
    expect(we?.source).toBe('inherited');
    expect(we?.points.map((p) => [p.id, p.source])).toEqual([
      [POINT_A, 'inherited'],
      [POINT_B, 'inherited'],
    ]);
    expect(view.resumeEntries[0]?.source).toBe('inherited');
  });

  it('marks a point hidden for the Target and keeps its siblings', () => {
    const view = resolveCareerBank(
      bank(),
      [override({ id: ID(10), action: 'hide', itemId: POINT_A })],
      new Map(),
    );
    expect(view.workExperiences[0]?.points.map((p) => [p.id, p.source, p.hidden])).toEqual([
      [POINT_A, 'hidden', true],
      [POINT_B, 'inherited', false],
    ]);
  });

  it('replaces the whole value of an item and keeps its id', () => {
    const view = resolveCareerBank(
      bank(),
      [
        override({
          id: ID(11),
          action: 'replace',
          itemId: POINT_A,
          value: { text: 'Cooked for 80 guests', skills: ['catering'] },
          baseRevisionId: ID(500),
        }),
      ],
      new Map([[POINT_A, ID(500)]]),
    );
    const point = view.workExperiences[0]?.points[0];
    expect(point).toMatchObject({
      id: POINT_A,
      text: 'Cooked for 80 guests',
      skills: ['catering'],
      source: 'replaced',
      overrideId: ID(11),
      stale: false,
    });
  });

  it('flags a replacement stale when the item has a newer revision than the one it was made against', () => {
    const view = resolveCareerBank(
      bank(),
      [
        override({
          id: ID(11),
          action: 'replace',
          itemId: POINT_A,
          value: { text: 'Cooked for 80 guests', skills: [] },
          baseRevisionId: ID(500),
        }),
      ],
      new Map([[POINT_A, ID(501)]]),
    );
    expect(view.workExperiences[0]?.points[0]).toMatchObject({ source: 'replaced', stale: true });
  });

  it('leaves out items the Career bank itself hides, with their children', () => {
    const b = bank();
    const we = b.workExperiences[0];
    if (!we) throw new Error('fixture');
    we.hidden = true;
    expect(resolveCareerBank(b, [], new Map()).workExperiences).toEqual([]);
    we.hidden = false;
    const p = we.points[0];
    if (!p) throw new Error('fixture');
    p.hidden = true;
    expect(resolveCareerBank(b, [], new Map()).workExperiences[0]?.points.map((x) => x.id)).toEqual(
      [POINT_B],
    );
  });

  it('appends Target-only additions after the inherited items, in creation order', () => {
    const view = resolveCareerBank(
      bank(),
      [
        override({
          id: ID(21),
          action: 'add',
          itemKind: 'experience_point',
          parentId: WE,
          value: { text: 'Second added', skills: [] },
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }),
        override({
          id: ID(20),
          action: 'add',
          itemKind: 'experience_point',
          parentId: WE,
          value: { text: 'First added', skills: ['plating'] },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        override({
          id: ID(22),
          action: 'add',
          itemKind: 'resume_entry',
          value: { kind: 'skill', name: 'Plating' },
        }),
      ],
      new Map(),
    );
    expect(view.workExperiences[0]?.points.map((p) => [p.id, p.source])).toEqual([
      [POINT_A, 'inherited'],
      [POINT_B, 'inherited'],
      [ID(20), 'added'],
      [ID(21), 'added'],
    ]);
    expect(view.resumeEntries.map((e) => [e.id, e.source, e.overrideId])).toEqual([
      [ENTRY, 'inherited', null],
      [ID(22), 'added', ID(22)],
    ]);
  });

  it('hides the children of a Work experience the Target hides, additions included', () => {
    const view = resolveCareerBank(
      bank(),
      [
        override({ id: ID(30), action: 'hide', itemKind: 'work_experience', itemId: WE }),
        override({
          id: ID(31),
          action: 'add',
          itemKind: 'experience_point',
          parentId: WE,
          value: { text: 'Added', skills: [] },
        }),
      ],
      new Map(),
    );
    const we = view.workExperiences[0];
    expect(we?.source).toBe('hidden');
    expect(we?.hidden).toBe(true);
    expect(we?.points.map((p) => [p.source, p.hidden])).toEqual([
      ['hidden', true],
      ['hidden', true],
      ['hidden', true],
    ]);
  });

  it('shows a Target-only Work experience with the points added under it', () => {
    const view = resolveCareerBank(
      bank(),
      [
        override({
          id: ID(40),
          action: 'add',
          itemKind: 'work_experience',
          value: {
            role: 'Barista',
            organisation: 'Example Cafe',
            start: '2019',
            end: '2020',
            place: null,
          },
        }),
        override({
          id: ID(41),
          action: 'add',
          itemKind: 'experience_point',
          parentId: ID(40),
          value: { text: 'Poured latte art', skills: [] },
        }),
      ],
      new Map(),
    );
    const added = view.workExperiences[1];
    expect(added).toMatchObject({ id: ID(40), role: 'Barista', source: 'added' });
    expect(added?.points.map((p) => [p.id, p.source])).toEqual([[ID(41), 'added']]);
  });
});
