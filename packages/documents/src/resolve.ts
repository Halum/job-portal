import type { CareerBank } from './documents';

import type { OverrideAction, OverrideItemKind } from './schema';

export {
  OVERRIDE_ACTIONS,
  OVERRIDE_ITEM_KINDS,
  type OverrideAction,
  type OverrideItemKind,
} from './schema';

/** One Career bank override of a Target. */
export interface CareerOverride {
  id: string;
  targetId: string;
  action: OverrideAction;
  itemKind: OverrideItemKind;
  /** The Career bank item a hide or replace is about. */
  itemId: string | null;
  /** The parent of an added Experience point or Cover letter paragraph. */
  parentId: string | null;
  /** The whole typed item value of a replace or an add. */
  value: Record<string, unknown> | null;
  /** The revision the replaced item had when the replace was made. */
  baseRevisionId: string | null;
  createdAt: Date;
}

export const ITEM_SOURCES = ['inherited', 'replaced', 'added', 'hidden'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** An item of a Target career bank: its value, where it came from and, when an override made it, which one. */
export type Marked<T> = T & {
  id: string;
  hidden: boolean;
  source: ItemSource;
  overrideId: string | null;
  /** A replacement made against an older revision than the item's current one. */
  stale: boolean;
};

type Item = { id: string; hidden: boolean };
type WE = Omit<CareerBank['workExperiences'][number], 'points'>;
type EP = CareerBank['workExperiences'][number]['points'][number];
type RE = CareerBank['resumeEntries'][number];
type OS = Omit<CareerBank['coverLetterOutline'][number], 'paragraphs'>;
type CLP = CareerBank['coverLetterOutline'][number]['paragraphs'][number];

export interface TargetCareerBank {
  masterDocuments: CareerBank['masterDocuments'];
  workExperiences: (Marked<WE> & {
    points: Marked<EP>[];
  })[];
  resumeEntries: Marked<RE>[];
  coverLetterOutline: (Marked<OS> & {
    paragraphs: Marked<CLP>[];
  })[];
  writingStyle: Marked<NonNullable<CareerBank['writingStyle']>> | null;
  contact: Marked<NonNullable<CareerBank['contact']>> | null;
}

/**
 * What one Target sees: the Career bank without its own hidden items, minus the Target's hides,
 * plus its replacements and additions. Pure. `latestRevision` maps an item id to its newest revision id.
 */
export function resolveCareerBank(
  bank: CareerBank,
  overrides: readonly CareerOverride[],
  latestRevision: ReadonlyMap<string, string>,
): TargetCareerBank {
  const hides = new Map<string, CareerOverride>();
  const replaces = new Map<string, CareerOverride>();
  for (const o of overrides) {
    if (o.itemId === null) continue;
    if (o.action === 'hide') hides.set(o.itemId, o);
    if (o.action === 'replace') replaces.set(o.itemId, o);
  }

  const adds = overrides
    .filter((o) => o.action === 'add' && o.value !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const addsOf = (kind: OverrideItemKind, parentId: string | null) =>
    adds.filter((o) => o.itemKind === kind && o.parentId === parentId);
  const added = <T extends Item>(o: CareerOverride, parentHidden = false): Marked<T> => ({
    ...(o.value as unknown as T),
    id: o.id,
    hidden: parentHidden,
    source: parentHidden ? 'hidden' : 'added',
    overrideId: o.id,
    stale: false,
  });

  const mark = <T extends Item>(item: T, parentHidden = false): Marked<T> => {
    const hide = hides.get(item.id);
    if (hide || parentHidden) {
      return {
        ...item,
        hidden: true,
        source: 'hidden',
        overrideId: hide?.id ?? null,
        stale: false,
      };
    }
    const replace = replaces.get(item.id);
    if (replace?.value) {
      return {
        ...(replace.value as unknown as T),
        id: item.id,
        hidden: false,
        source: 'replaced',
        overrideId: replace.id,
        stale:
          replace.baseRevisionId !== null && latestRevision.get(item.id) !== replace.baseRevisionId,
      };
    }
    return { ...item, source: 'inherited', overrideId: null, stale: false };
  };
  const shown = <T extends Item>(items: readonly T[]) => items.filter((i) => !i.hidden);

  return {
    masterDocuments: bank.masterDocuments,
    workExperiences: [
      ...shown(bank.workExperiences).map((we) => {
        const marked = mark(we);
        const hidden = marked.source === 'hidden';
        return {
          ...marked,
          points: [
            ...shown(we.points).map((p) => mark(p, hidden)),
            ...addsOf('experience_point', we.id).map((o) => added<EP>(o, hidden)),
          ],
        };
      }),
      ...addsOf('work_experience', null).map((o) => ({
        ...added<WE>(o),
        points: addsOf('experience_point', o.id).map((p) => added<EP>(p)),
      })),
    ],
    resumeEntries: [
      ...shown(bank.resumeEntries).map((e) => mark(e)),
      ...addsOf('resume_entry', null).map((o) => added<RE>(o)),
    ],
    coverLetterOutline: shown(bank.coverLetterOutline).map((s) => {
      const marked = mark(s);
      const hidden = marked.source === 'hidden';
      return {
        ...marked,
        paragraphs: [
          ...shown(s.paragraphs).map((p) => mark(p, hidden)),
          ...addsOf('cover_letter_paragraph', s.id).map((o) => added<CLP>(o, hidden)),
        ],
      };
    }),
    writingStyle: bank.writingStyle ? mark(bank.writingStyle) : null,
    contact: bank.contact ? mark(bank.contact) : null,
  };
}
