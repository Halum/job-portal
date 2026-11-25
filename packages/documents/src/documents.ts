import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@job-portal/db';
import { DocumentsError } from './errors';
import { createPacketOps, type PacketOps } from './packets';
import {
  careerItems,
  careerOverrides,
  careerRevisions,
  fileBytes,
  files,
  masterDocuments,
  SINGLETON_KINDS,
  type CareerItemKind,
  type FileKind,
  type MasterKind,
  type StoredFileKind,
  type RevisionActor,
  type RevisionItemKind,
  type RevisionReason,
} from './schema';
import {
  OVERRIDE_ITEM_KINDS,
  resolveCareerBank,
  type CareerOverride,
  type OverrideAction,
  type OverrideItemKind,
  type TargetCareerBank,
} from './resolve';

export { FILE_KINDS, MASTER_KINDS, type FileKind, type MasterKind } from './schema';
export {
  CAREER_ITEM_KINDS,
  REVISION_ACTORS,
  REVISION_ITEM_KINDS,
  REVISION_REASONS,
  type CareerItemKind,
  type RevisionActor,
  type RevisionReason,
} from './schema';

/** The upload limit, per file. The route enforces it before it reads the whole body. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Caps on the Career bank: text lengths and list sizes, enforced at the MCP boundary and on import. */
export const CAREER_LIMITS = {
  text: 1000,
  short: 200,
  labelLength: 60,
  labels: 20,
  points: 50,
  experiences: 50,
  entries: 100,
  sections: 20,
  paragraphs: 20,
  words: 50,
  links: 10,
};

const partialDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'use YYYY, YYYY-MM or YYYY-MM-DD');

/** The stored value of a Work experience. */
export const workExperienceValue = z.object({
  role: z.string().min(1).max(CAREER_LIMITS.short),
  organisation: z.string().min(1).max(CAREER_LIMITS.short),
  start: partialDate,
  end: partialDate.nullable().describe('null while the role is current'),
  place: z.string().max(CAREER_LIMITS.short).nullable(),
});
export type WorkExperienceValue = z.infer<typeof workExperienceValue>;

/** The stored value of an Experience point; skills are its labels. */
export const experiencePointValue = z.object({
  text: z.string().min(1).max(CAREER_LIMITS.text),
  skills: z.array(z.string().min(1).max(CAREER_LIMITS.labelLength)).max(CAREER_LIMITS.labels),
});
export type ExperiencePointValue = z.infer<typeof experiencePointValue>;

const short = z.string().min(1).max(CAREER_LIMITS.short);
const label = z.string().min(1).max(CAREER_LIMITS.labelLength);

/** The stored value of a Resume entry; the fields depend on its kind. */
export const resumeEntryValue = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('education'),
    institution: short,
    degree: short,
    start: partialDate.nullable(),
    end: partialDate.nullable(),
    place: short.nullable(),
  }),
  z.object({ kind: z.literal('skill'), name: short }),
  z.object({ kind: z.literal('language'), name: short, level: short.nullable() }),
  z.object({
    kind: z.literal('certificate'),
    name: short,
    issuer: short.nullable(),
    date: partialDate.nullable(),
  }),
]);
export type ResumeEntryValue = z.infer<typeof resumeEntryValue>;

/** The stored value of a Cover letter outline section. */
export const outlineSectionValue = z.object({ name: short });
export type OutlineSectionValue = z.infer<typeof outlineSectionValue>;

/** The stored value of a Cover letter paragraph; themes and skills are its labels. */
export const coverLetterParagraphValue = z.object({
  text: z.string().min(1).max(CAREER_LIMITS.text),
  themes: z.array(label).max(CAREER_LIMITS.labels),
  skills: z.array(label).max(CAREER_LIMITS.labels),
});
export type CoverLetterParagraphValue = z.infer<typeof coverLetterParagraphValue>;

/** The Writing style profile, one per user. */
export const writingStyleValue = z.object({
  tone: short,
  sentenceNotes: z.string().min(1).max(CAREER_LIMITS.text),
  wordsUsed: z.array(label).max(CAREER_LIMITS.words),
  wordsAvoided: z.array(label).max(CAREER_LIMITS.words),
  salutation: short,
  signOff: short,
});
export type WritingStyleValue = z.infer<typeof writingStyleValue>;

/** The contact details, one set per user; the photo is an uploaded file id of kind photo. */
export const contactValue = z.object({
  name: short,
  address: short.nullable(),
  phone: short.nullable(),
  email: short.nullable(),
  links: z
    .array(
      z
        .string()
        .regex(/^https?:\/\/\S+$/, 'use an http or https link')
        .max(300),
    )
    .max(CAREER_LIMITS.links),
  photoFileId: z.uuid().nullable(),
});
export type ContactValue = z.infer<typeof contactValue>;

/** One zod schema per item kind: the import, every edit and a restore parse with it, and `getCareerBank` parses stored values with it. */
const VALUE_SCHEMAS: Record<CareerItemKind, z.ZodType> = {
  work_experience: workExperienceValue,
  experience_point: experiencePointValue,
  resume_entry: resumeEntryValue,
  outline_section: outlineSectionValue,
  cover_letter_paragraph: coverLetterParagraphValue,
  writing_style: writingStyleValue,
  contact: contactValue,
};

/** Kinds that sit under a parent item, and the kind that parent must be. */
const PARENT_KIND: Partial<Record<CareerItemKind, CareerItemKind>> = {
  experience_point: 'work_experience',
  cover_letter_paragraph: 'outline_section',
};

/** A reviewed parse of the Master resume and Master cover letter. Every part is optional, but not all of them. */
export const careerBankImport = z.object({
  workExperiences: z
    .array(
      workExperienceValue.extend({
        points: z.array(experiencePointValue).max(CAREER_LIMITS.points),
      }),
    )
    .max(CAREER_LIMITS.experiences)
    .default([]),
  resumeEntries: z.array(resumeEntryValue).max(CAREER_LIMITS.entries).default([]),
  coverLetterOutline: z
    .array(
      outlineSectionValue.extend({
        paragraphs: z.array(coverLetterParagraphValue).max(CAREER_LIMITS.paragraphs),
      }),
    )
    .max(CAREER_LIMITS.sections)
    .default([]),
  writingStyle: writingStyleValue.optional(),
  contact: contactValue.optional(),
});
export type CareerBankImport = z.infer<typeof careerBankImport>;

/** The reasons a caller may give to `upsertItem`; import, hide and restore are written by their own calls. */
export const CAREER_EDIT_REASONS = ['coaching', 'enrichment', 'user_edit'] as const;

export { DocumentsError };
export * from './packets';

export interface FileInfo {
  id: string;
  kind: StoredFileKind;
  filename: string;
  mediaType: string;
  size: number;
  createdAt: Date;
}

export interface NewFile {
  kind: FileKind;
  filename: string;
  bytes: Buffer;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const startsWith = (b: Buffer, magic: number[]): boolean => magic.every((m, i) => b[i] === m);

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when the zip's central directory lists an entry with exactly this name (file content is never searched). */
function zipHasEntry(zip: Buffer, name: string): boolean {
  // The end-of-central-directory record is within the last 22 + 65535 bytes.
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), zip.length - 22);
  if (end < 0 || end < zip.length - 22 - 0xffff) return false;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return false;
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (next > zip.length) return false;
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) return true;
    at = next;
  }
  return false;
}

/** The media type of an upload, decided from its content alone; null when the kind does not allow it. */
export function detectMediaType(kind: FileKind, filename: string, bytes: Buffer): string | null {
  if (kind === 'photo') {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    return null;
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return zipHasEntry(bytes, 'word/document.xml') ? DOCX : null;
  }
  if (isUtf8Text(bytes)) return /\.(md|markdown)$/i.test(filename) ? 'text/markdown' : 'text/plain';
  return null;
}

const infoColumns = {
  id: files.id,
  kind: files.kind,
  filename: files.filename,
  mediaType: files.mediaType,
  size: files.size,
  createdAt: files.createdAt,
};

type Stored<T> = T & { id: string; hidden: boolean };

export interface CareerBank {
  masterDocuments: { masterResume: FileInfo | null; masterCoverLetter: FileInfo | null };
  workExperiences: (Stored<WorkExperienceValue> & { points: Stored<ExperiencePointValue>[] })[];
  resumeEntries: Stored<ResumeEntryValue>[];
  coverLetterOutline: (Stored<OutlineSectionValue> & {
    paragraphs: Stored<CoverLetterParagraphValue>[];
  })[];
  writingStyle: Stored<WritingStyleValue> | null;
  contact: Stored<ContactValue> | null;
}

/** One stored Career bank item as the write calls return it. */
export interface CareerItem {
  id: string;
  kind: CareerItemKind;
  parentId: string | null;
  hidden: boolean;
  value: Record<string, unknown>;
}

export interface CareerRevision {
  id: string;
  itemKind: RevisionItemKind;
  itemId: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown>;
  reason: RevisionReason;
  actor: RevisionActor;
  createdAt: Date;
}

export interface ImportCounts {
  workExperiences: number;
  experiencePoints: number;
  resumeEntries: number;
  outlineSections: number;
  coverLetterParagraphs: number;
  writingStyle: boolean;
  contact: boolean;
}

export interface UpsertItemInput {
  itemKind: CareerItemKind;
  /** Edit this item; leave out to add one (the Writing style and the contact details are edited in place either way). */
  itemId?: string;
  /** The Work experience of an Experience point, or the outline section of a Cover letter paragraph. */
  parentId?: string;
  value: unknown;
  reason: (typeof CAREER_EDIT_REASONS)[number];
  actor: RevisionActor;
}

export interface SetOverrideInput {
  /** A Target of this user, checked through the injected lookup. */
  targetId: string;
  action: OverrideAction;
  /** The Career bank item a hide or replace is about; its kind is the item's own, and one given here must match. */
  itemId?: string;
  /** Needed to add; the kind of the new item. */
  itemKind?: OverrideItemKind;
  /** The Work experience (a Career bank one, or one this Target added) of an added Experience point, or the outline section of an added Cover letter paragraph. */
  parentId?: string;
  /** Edit this added item instead of adding another. */
  overrideId?: string;
  /** The whole typed item value of a replace or an add. */
  value?: unknown;
  reason: (typeof CAREER_EDIT_REASONS)[number];
  actor: RevisionActor;
}

/** The lookups Documents needs from other modules; the API builds them (ADR 0009 style injection). */
export interface DocumentsDeps {
  /** True when the Target exists and belongs to the user. Left out: every Target call is refused. */
  hasTarget?: (userId: string, targetId: string) => Promise<boolean>;
  /** True when the Job exists and belongs to the user (Discovery). Left out: every Application packet call is refused. */
  hasJob?: (userId: string, jobId: string) => Promise<boolean>;
}

export interface Documents extends PacketOps {
  /** Checks the content type and stores the file; a new upload of a kind never removes an older one. */
  storeFile: (userId: string, file: NewFile) => Promise<FileInfo>;
  /** The file and its bytes, or null when the id is unknown or belongs to another user. */
  getFile: (userId: string, id: string) => Promise<{ info: FileInfo; bytes: Buffer } | null>;
  /** Makes an uploaded file of that kind the current Master; older uploads stay. Another user's or unknown id: not_found. */
  registerMaster: (userId: string, kind: MasterKind, fileId: string) => Promise<FileInfo>;
  /** Adds a reviewed parse after the existing items, each write a Career bank revision (reason import). A Writing style or contact details already stored are updated. */
  importCareerBank: (
    userId: string,
    input: CareerBankImport,
    actor: RevisionActor,
  ) => Promise<ImportCounts>;
  /** The whole Career bank, hidden items included and marked. */
  getCareerBank: (userId: string) => Promise<CareerBank>;
  /** Adds or edits one item; the value is parsed with the kind's own schema and every id must be the user's (not_found otherwise). */
  upsertItem: (userId: string, input: UpsertItemInput) => Promise<CareerItem>;
  /** The delete of the Career bank: hides the item and records a revision (reason hide). Not for the Writing style or contact details. */
  hideItem: (userId: string, itemId: string, actor: RevisionActor) => Promise<CareerItem>;
  /** Without a revision id: unhides a hidden item. With one: sets the item's text back to that revision's text (and unhides it). Either way a new revision (reason restore). */
  restoreItem: (
    userId: string,
    itemId: string,
    actor: RevisionActor,
    revisionId?: string,
  ) => Promise<CareerItem>;
  /** The history of one item, oldest first; not_found for an item that is not the user's. */
  listRevisions: (userId: string, itemId: string) => Promise<CareerRevision[]>;
  /** Hides or replaces one Career bank item for a Target, or adds a Target-only item; changing an existing hide or replace of the item updates it in place. Each call is a revision of item kind override. */
  setOverride: (userId: string, input: SetOverrideInput) => Promise<CareerOverride>;
  /** Removes an override so the Target follows the Career bank again; a revision (reason restore) keeps what it was. */
  clearOverride: (
    userId: string,
    overrideId: string,
    actor: RevisionActor,
  ) => Promise<CareerOverride>;
  /** What one Target sees: the Career bank resolved through its overrides, each item marked inherited, replaced, added or hidden. */
  getTargetCareerBank: (userId: string, targetId: string) => Promise<TargetCareerBank>;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const NOT_FOUND = 'no such Career bank item';

const itemColumns = {
  id: careerItems.id,
  kind: careerItems.kind,
  parentId: careerItems.parentId,
  hidden: careerItems.hidden,
  value: careerItems.value,
};

function parseValue(kind: CareerItemKind, raw: unknown): Record<string, unknown> {
  const parsed = VALUE_SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) {
    throw new DocumentsError(
      'invalid_argument',
      `invalid ${kind}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

/** One write at a time per user, so positions continue without gaps or duplicates. */
const lockUser = (tx: Tx, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'documents.career:' + userId}))`);

const revise = (
  tx: Tx,
  userId: string,
  item: { kind: RevisionItemKind; id: string },
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown>,
  reason: RevisionReason,
  actor: RevisionActor,
) =>
  tx.insert(careerRevisions).values({
    userId,
    itemKind: item.kind,
    itemId: item.id,
    oldValue,
    newValue,
    reason,
    actor,
  });

async function ownedItem(tx: Pick<Db, 'select'>, userId: string, id: string): Promise<CareerItem> {
  const [item] = await tx
    .select(itemColumns)
    .from(careerItems)
    .where(and(eq(careerItems.id, id), eq(careerItems.userId, userId)));
  if (!item) throw new DocumentsError('not_found', NOT_FOUND);
  return item;
}

async function checkPhoto(
  tx: Tx,
  userId: string,
  kind: CareerItemKind,
  value: Record<string, unknown>,
) {
  if (kind !== 'contact' || typeof value.photoFileId !== 'string') return;
  const [photo] = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, value.photoFileId), eq(files.userId, userId), eq(files.kind, 'photo')));
  if (!photo) throw new DocumentsError('not_found', 'no uploaded photo with that file id');
}

async function insertItem(
  tx: Tx,
  userId: string,
  kind: CareerItemKind,
  parentId: string | null,
  value: Record<string, unknown>,
  reason: RevisionReason,
  actor: RevisionActor,
): Promise<CareerItem> {
  const [last] = await tx
    .select({ position: careerItems.position })
    .from(careerItems)
    .where(
      and(
        eq(careerItems.userId, userId),
        eq(careerItems.kind, kind),
        parentId === null ? isNull(careerItems.parentId) : eq(careerItems.parentId, parentId),
      ),
    )
    .orderBy(desc(careerItems.position))
    .limit(1);
  const [row] = await tx
    .insert(careerItems)
    .values({ userId, kind, parentId, position: (last?.position ?? -1) + 1, value })
    .returning(itemColumns);
  if (!row) throw new Error('career item insert returned no row');
  await revise(tx, userId, row, null, value, reason, actor);
  return row;
}

/** Sets the item's value (and whether it is hidden) and records the revision. */
async function changeItem(
  tx: Tx,
  userId: string,
  item: CareerItem,
  change: { value: Record<string, unknown>; hidden: boolean },
  reason: RevisionReason,
  actor: RevisionActor,
): Promise<CareerItem> {
  await tx.update(careerItems).set(change).where(eq(careerItems.id, item.id));
  await revise(tx, userId, item, item.value, change.value, reason, actor);
  return { ...item, ...change };
}

/** Adds the Writing style or the contact details, or updates the one already stored. */
async function writeSingleton(
  tx: Tx,
  userId: string,
  kind: CareerItemKind,
  value: Record<string, unknown>,
  reason: RevisionReason,
  actor: RevisionActor,
): Promise<CareerItem> {
  const [existing] = await tx
    .select(itemColumns)
    .from(careerItems)
    .where(and(eq(careerItems.userId, userId), eq(careerItems.kind, kind)));
  return existing
    ? changeItem(tx, userId, existing, { value, hidden: existing.hidden }, reason, actor)
    : insertItem(tx, userId, kind, null, value, reason, actor);
}

const overrideColumns = {
  id: careerOverrides.id,
  targetId: careerOverrides.targetId,
  action: careerOverrides.action,
  itemKind: careerOverrides.itemKind,
  itemId: careerOverrides.itemId,
  parentId: careerOverrides.parentId,
  value: careerOverrides.value,
  baseRevisionId: careerOverrides.baseRevisionId,
  createdAt: careerOverrides.createdAt,
};

/** What a revision of an override records: everything that says what the override did. */
const snapshot = (o: Omit<CareerOverride, 'createdAt' | 'baseRevisionId' | 'id'>) => ({
  targetId: o.targetId,
  action: o.action,
  itemKind: o.itemKind,
  itemId: o.itemId,
  parentId: o.parentId,
  value: o.value,
});

/** The newest revision id of each given item (all of the user's when none are given). */
async function latestRevisionIds(
  db: Pick<Db, 'selectDistinctOn'>,
  userId: string,
  itemIds?: string[],
): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinctOn([careerRevisions.itemId], {
      id: careerRevisions.id,
      itemId: careerRevisions.itemId,
    })
    .from(careerRevisions)
    .where(
      and(
        eq(careerRevisions.userId, userId),
        itemIds ? inArray(careerRevisions.itemId, itemIds) : undefined,
      ),
    )
    .orderBy(careerRevisions.itemId, desc(careerRevisions.createdAt), desc(careerRevisions.id));
  return new Map(rows.map((r) => [r.itemId, r.id]));
}

type OverrideRow = CareerOverride;
type OverrideFields = Omit<CareerOverride, 'id' | 'targetId' | 'createdAt'>;

/** Updates the override in place, or inserts it, and records the revision of item kind override. */
async function saveOverride(
  tx: Tx,
  userId: string,
  targetId: string,
  old: OverrideRow | undefined,
  fields: OverrideFields,
  reason: RevisionReason,
  actor: RevisionActor,
): Promise<CareerOverride> {
  if (old) {
    await tx.update(careerOverrides).set(fields).where(eq(careerOverrides.id, old.id));
    const next = { ...old, ...fields };
    await revise(
      tx,
      userId,
      { kind: 'override', id: old.id },
      snapshot(old),
      snapshot(next),
      reason,
      actor,
    );
    return next;
  }
  const [row] = await tx
    .insert(careerOverrides)
    .values({ userId, targetId, ...fields })
    .returning(overrideColumns);
  if (!row) throw new Error('override insert returned no row');
  await revise(tx, userId, { kind: 'override', id: row.id }, null, snapshot(row), reason, actor);
  return row;
}

export function createDocuments(db: Db, deps: DocumentsDeps = {}): Documents {
  const requireTarget = async (userId: string, targetId: string) => {
    if (!(await deps.hasTarget?.(userId, targetId))) {
      throw new DocumentsError('not_found', 'no such Target');
    }
  };

  /** The parent of an added item: a Career bank item of the right kind, or a Work experience this Target added. */
  async function checkParent(
    tx: Tx,
    userId: string,
    targetId: string,
    kind: OverrideItemKind,
    parentId: string | undefined,
  ): Promise<string | null> {
    const parentKind = PARENT_KIND[kind];
    if (parentKind === undefined) {
      if (parentId !== undefined) {
        throw new DocumentsError('invalid_argument', `a ${kind} has no parent`);
      }
      return null;
    }
    if (parentId === undefined) {
      throw new DocumentsError('invalid_argument', `a ${kind} needs a parentId (a ${parentKind})`);
    }
    const [item] = await tx
      .select(itemColumns)
      .from(careerItems)
      .where(
        and(
          eq(careerItems.id, parentId),
          eq(careerItems.userId, userId),
          eq(careerItems.kind, parentKind),
        ),
      );
    if (item) {
      if (item.hidden) {
        throw new DocumentsError('invalid_argument', 'the parent is hidden, restore it first');
      }
      return item.id;
    }
    if (parentKind === 'work_experience') {
      const [own] = await tx
        .select({ id: careerOverrides.id })
        .from(careerOverrides)
        .where(
          and(
            eq(careerOverrides.id, parentId),
            eq(careerOverrides.userId, userId),
            eq(careerOverrides.targetId, targetId),
            eq(careerOverrides.action, 'add'),
            eq(careerOverrides.itemKind, 'work_experience'),
          ),
        );
      if (own) return own.id;
    }
    throw new DocumentsError('not_found', NOT_FOUND);
  }

  const requireJob = async (userId: string, jobId: string) => {
    if (!(await deps.hasJob?.(userId, jobId))) {
      throw new DocumentsError('not_found', 'no such Job');
    }
  };

  const api: Documents = {
    ...createPacketOps({
      db,
      requireTarget,
      requireJob,
      targetBank: (userId, targetId) => api.getTargetCareerBank(userId, targetId),
      latestRevisions: (userId, ids) => latestRevisionIds(db, userId, ids),
    }),
    async storeFile(userId, file) {
      if (file.bytes.length === 0)
        throw new DocumentsError('invalid_argument', 'the file is empty');
      if (file.bytes.length > MAX_FILE_BYTES) {
        throw new DocumentsError('invalid_argument', 'the file is over the size limit');
      }
      const mediaType = detectMediaType(file.kind, file.filename, file.bytes);
      if (mediaType === null) {
        throw new DocumentsError(
          'unsupported_type',
          file.kind === 'photo'
            ? 'a photo must be a PNG or JPEG'
            : 'a Master file must be a PDF, DOCX, Markdown or UTF-8 text file',
        );
      }
      return db.transaction(async (tx) => {
        const [info] = await tx
          .insert(files)
          .values({
            userId,
            kind: file.kind,
            filename: file.filename,
            mediaType,
            size: file.bytes.length,
          })
          .returning(infoColumns);
        if (!info) throw new Error('file insert returned no row');
        await tx.insert(fileBytes).values({ fileId: info.id, bytes: file.bytes });
        return info;
      });
    },

    async registerMaster(userId, kind, fileId) {
      return db.transaction(async (tx) => {
        const [info] = await tx
          .select(infoColumns)
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.userId, userId), eq(files.kind, kind)));
        if (!info) throw new DocumentsError('not_found', `no uploaded ${kind} with that file id`);
        await tx
          .insert(masterDocuments)
          .values({ userId, kind, fileId })
          .onConflictDoUpdate({
            target: [masterDocuments.userId, masterDocuments.kind],
            set: { fileId, registeredAt: sql`now()` },
          });
        return info;
      });
    },

    async importCareerBank(userId, input, actor) {
      const { workExperiences, resumeEntries, coverLetterOutline, writingStyle, contact } = input;
      if (
        workExperiences.length === 0 &&
        resumeEntries.length === 0 &&
        coverLetterOutline.length === 0 &&
        !writingStyle &&
        !contact
      ) {
        throw new DocumentsError('invalid_argument', 'there is nothing to import');
      }
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const add = (
          kind: CareerItemKind,
          parentId: string | null,
          value: Record<string, unknown>,
        ) => insertItem(tx, userId, kind, parentId, value, 'import', actor);
        let experiencePoints = 0;
        let coverLetterParagraphs = 0;
        for (const { points, ...value } of workExperiences) {
          const item = await add('work_experience', null, value);
          for (const point of points) {
            await add('experience_point', item.id, point);
            experiencePoints++;
          }
        }
        for (const value of resumeEntries) await add('resume_entry', null, value);
        for (const { paragraphs, ...value } of coverLetterOutline) {
          const item = await add('outline_section', null, value);
          for (const paragraph of paragraphs) {
            await add('cover_letter_paragraph', item.id, paragraph);
            coverLetterParagraphs++;
          }
        }
        if (writingStyle) {
          await writeSingleton(tx, userId, 'writing_style', writingStyle, 'import', actor);
        }
        if (contact) {
          await checkPhoto(tx, userId, 'contact', contact);
          await writeSingleton(tx, userId, 'contact', contact, 'import', actor);
        }
        return {
          workExperiences: workExperiences.length,
          experiencePoints,
          resumeEntries: resumeEntries.length,
          outlineSections: coverLetterOutline.length,
          coverLetterParagraphs,
          writingStyle: writingStyle !== undefined,
          contact: contact !== undefined,
        };
      });
    },

    async upsertItem(userId, input) {
      const { itemKind: kind } = input;
      const value = parseValue(kind, input.value);
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        await checkPhoto(tx, userId, kind, value);
        if (input.itemId !== undefined) {
          const item = await ownedItem(tx, userId, input.itemId);
          if (item.kind !== kind) {
            throw new DocumentsError(
              'invalid_argument',
              `that item is a ${item.kind}, not a ${kind}`,
            );
          }
          if (input.parentId !== undefined && input.parentId !== item.parentId) {
            throw new DocumentsError('invalid_argument', 'an item cannot move to another parent');
          }
          return changeItem(
            tx,
            userId,
            item,
            { value, hidden: item.hidden },
            input.reason,
            input.actor,
          );
        }
        if (SINGLETON_KINDS.includes(kind)) {
          return writeSingleton(tx, userId, kind, value, input.reason, input.actor);
        }
        const parentKind = PARENT_KIND[kind];
        if (parentKind === undefined) {
          if (input.parentId !== undefined) {
            throw new DocumentsError('invalid_argument', `a ${kind} has no parent`);
          }
          return insertItem(tx, userId, kind, null, value, input.reason, input.actor);
        }
        if (input.parentId === undefined) {
          throw new DocumentsError(
            'invalid_argument',
            `a ${kind} needs a parentId (a ${parentKind})`,
          );
        }
        const parent = await ownedItem(tx, userId, input.parentId);
        if (parent.kind !== parentKind) throw new DocumentsError('not_found', NOT_FOUND);
        if (parent.hidden) {
          throw new DocumentsError('invalid_argument', 'the parent is hidden, restore it first');
        }
        return insertItem(tx, userId, kind, parent.id, value, input.reason, input.actor);
      });
    },

    async hideItem(userId, itemId, actor) {
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const item = await ownedItem(tx, userId, itemId);
        if (SINGLETON_KINDS.includes(item.kind)) {
          throw new DocumentsError(
            'invalid_argument',
            `a ${item.kind} cannot be hidden, edit it instead`,
          );
        }
        if (item.hidden) throw new DocumentsError('invalid_argument', 'the item is already hidden');
        return changeItem(tx, userId, item, { value: item.value, hidden: true }, 'hide', actor);
      });
    },

    async restoreItem(userId, itemId, actor, revisionId) {
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const item = await ownedItem(tx, userId, itemId);
        if (revisionId === undefined) {
          if (!item.hidden) throw new DocumentsError('invalid_argument', 'the item is not hidden');
          return changeItem(
            tx,
            userId,
            item,
            { value: item.value, hidden: false },
            'restore',
            actor,
          );
        }
        const [revision] = await tx
          .select({ newValue: careerRevisions.newValue })
          .from(careerRevisions)
          .where(
            and(
              eq(careerRevisions.id, revisionId),
              eq(careerRevisions.userId, userId),
              eq(careerRevisions.itemId, item.id),
            ),
          );
        if (!revision) throw new DocumentsError('not_found', NOT_FOUND);
        const value = parseValue(item.kind, revision.newValue);
        await checkPhoto(tx, userId, item.kind, value);
        return changeItem(tx, userId, item, { value, hidden: false }, 'restore', actor);
      });
    },

    async getCareerBank(userId) {
      const [items, masters] = await Promise.all([
        db
          .select()
          .from(careerItems)
          .where(eq(careerItems.userId, userId))
          .orderBy(asc(careerItems.position), asc(careerItems.createdAt)),
        db
          .select(infoColumns)
          .from(masterDocuments)
          .innerJoin(files, eq(files.id, masterDocuments.fileId))
          .where(eq(masterDocuments.userId, userId)),
      ]);
      const infoOf = (kind: MasterKind): FileInfo | null =>
        masters.find((x) => x.kind === kind) ?? null;
      const ofKind = (kind: CareerItemKind) => items.filter((i) => i.kind === kind);
      const under = (parentId: string, kind: CareerItemKind) =>
        items.filter((i) => i.kind === kind && i.parentId === parentId);
      const stored = <T extends object>(schema: z.ZodType<T>, i: (typeof items)[number]) => ({
        id: i.id,
        hidden: i.hidden,
        ...schema.parse(i.value),
      });
      const single = <T extends object>(kind: CareerItemKind, schema: z.ZodType<T>) => {
        const i = ofKind(kind)[0];
        return i ? stored(schema, i) : null;
      };
      return {
        masterDocuments: {
          masterResume: infoOf('master_resume'),
          masterCoverLetter: infoOf('master_cover_letter'),
        },
        workExperiences: ofKind('work_experience').map((we) => ({
          ...stored(workExperienceValue, we),
          points: under(we.id, 'experience_point').map((p) => stored(experiencePointValue, p)),
        })),
        resumeEntries: ofKind('resume_entry').map((e) => stored(resumeEntryValue, e)),
        coverLetterOutline: ofKind('outline_section').map((s) => ({
          ...stored(outlineSectionValue, s),
          paragraphs: under(s.id, 'cover_letter_paragraph').map((p) =>
            stored(coverLetterParagraphValue, p),
          ),
        })),
        writingStyle: single('writing_style', writingStyleValue),
        contact: single('contact', contactValue),
      };
    },

    async listRevisions(userId, itemId) {
      // Every item and every override has at least one revision, so a user's history exists exactly when the id is theirs.
      const [any] = await db
        .select({ id: careerRevisions.id })
        .from(careerRevisions)
        .where(and(eq(careerRevisions.userId, userId), eq(careerRevisions.itemId, itemId)))
        .limit(1);
      if (!any) throw new DocumentsError('not_found', NOT_FOUND);
      return db
        .select({
          id: careerRevisions.id,
          itemKind: careerRevisions.itemKind,
          itemId: careerRevisions.itemId,
          oldValue: careerRevisions.oldValue,
          newValue: careerRevisions.newValue,
          reason: careerRevisions.reason,
          actor: careerRevisions.actor,
          createdAt: careerRevisions.createdAt,
        })
        .from(careerRevisions)
        .where(and(eq(careerRevisions.userId, userId), eq(careerRevisions.itemId, itemId)))
        .orderBy(asc(careerRevisions.createdAt), asc(careerRevisions.id));
    },

    async getFile(userId, id) {
      const [info] = await db
        .select(infoColumns)
        .from(files)
        .where(and(eq(files.id, id), eq(files.userId, userId)));
      if (!info) return null;
      const [row] = await db
        .select({ bytes: fileBytes.bytes })
        .from(fileBytes)
        .where(eq(fileBytes.fileId, id));
      return row ? { info, bytes: row.bytes } : null;
    },
    async setOverride(userId, input) {
      const { targetId, action, reason, actor } = input;
      await requireTarget(userId, targetId);
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        if (action === 'add') {
          if (input.itemId !== undefined) {
            throw new DocumentsError('invalid_argument', 'an add names no itemId');
          }
          const kind = input.itemKind;
          if (kind === undefined || !OVERRIDE_ITEM_KINDS.includes(kind)) {
            throw new DocumentsError(
              'invalid_argument',
              `an add needs itemKind, one of ${OVERRIDE_ITEM_KINDS.join(', ')}`,
            );
          }
          if (input.value === undefined) {
            throw new DocumentsError('invalid_argument', 'an add needs a value');
          }
          const value = parseValue(kind, input.value);
          const parentId = await checkParent(tx, userId, targetId, kind, input.parentId);
          let old: OverrideRow | undefined;
          if (input.overrideId !== undefined) {
            [old] = await tx
              .select(overrideColumns)
              .from(careerOverrides)
              .where(
                and(
                  eq(careerOverrides.id, input.overrideId),
                  eq(careerOverrides.userId, userId),
                  eq(careerOverrides.targetId, targetId),
                  eq(careerOverrides.action, 'add'),
                ),
              );
            if (!old) throw new DocumentsError('not_found', NOT_FOUND);
            if (old.itemKind !== kind) {
              throw new DocumentsError('invalid_argument', 'an added item cannot change its kind');
            }
          }
          const fields = {
            action,
            itemKind: kind,
            itemId: null,
            parentId,
            value,
            baseRevisionId: null,
          };
          return saveOverride(tx, userId, targetId, old, fields, reason, actor);
        }

        if (input.itemId === undefined) {
          throw new DocumentsError('invalid_argument', `a ${action} needs an itemId`);
        }
        if (input.overrideId !== undefined || input.parentId !== undefined) {
          throw new DocumentsError('invalid_argument', `a ${action} takes only an itemId`);
        }
        const item = await ownedItem(tx, userId, input.itemId);
        const kind = OVERRIDE_ITEM_KINDS.find((k) => k === item.kind);
        if (kind === undefined) {
          throw new DocumentsError(
            'invalid_argument',
            `a ${item.kind} cannot be overridden for a Target`,
          );
        }
        if (item.hidden) {
          throw new DocumentsError('invalid_argument', 'the item is hidden, restore it first');
        }
        if (input.itemKind !== undefined && input.itemKind !== kind) {
          throw new DocumentsError(
            'invalid_argument',
            `that item is a ${kind}, not a ${input.itemKind}`,
          );
        }
        let value: Record<string, unknown> | null = null;
        if (action === 'replace') {
          if (input.value === undefined) {
            throw new DocumentsError('invalid_argument', 'a replace needs a value');
          }
          value = parseValue(kind, input.value);
        } else if (input.value !== undefined) {
          throw new DocumentsError('invalid_argument', 'a hide takes no value');
        }
        const baseRevisionId =
          action === 'replace'
            ? ((await latestRevisionIds(tx, userId, [item.id])).get(item.id) ?? null)
            : null;
        const [old] = await tx
          .select(overrideColumns)
          .from(careerOverrides)
          .where(
            and(
              eq(careerOverrides.userId, userId),
              eq(careerOverrides.targetId, targetId),
              eq(careerOverrides.itemId, item.id),
            ),
          );
        const fields = {
          action,
          itemKind: kind,
          itemId: item.id,
          parentId: null,
          value,
          baseRevisionId,
        };
        return saveOverride(tx, userId, targetId, old, fields, reason, actor);
      });
    },

    async clearOverride(userId, overrideId, actor) {
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const [old] = await tx
          .select(overrideColumns)
          .from(careerOverrides)
          .where(and(eq(careerOverrides.id, overrideId), eq(careerOverrides.userId, userId)));
        if (!old) throw new DocumentsError('not_found', 'no such Career bank override');
        // Points added under a Target-only Work experience go with it, each with its own revision.
        const children = await tx
          .select(overrideColumns)
          .from(careerOverrides)
          .where(and(eq(careerOverrides.userId, userId), eq(careerOverrides.parentId, old.id)));
        for (const child of children) {
          await tx.delete(careerOverrides).where(eq(careerOverrides.id, child.id));
          await revise(
            tx,
            userId,
            { kind: 'override', id: child.id },
            snapshot(child),
            { cleared: true },
            'restore',
            actor,
          );
        }
        await tx.delete(careerOverrides).where(eq(careerOverrides.id, old.id));
        await revise(
          tx,
          userId,
          { kind: 'override', id: old.id },
          snapshot(old),
          { cleared: true },
          'restore',
          actor,
        );
        return old;
      });
    },

    async getTargetCareerBank(userId, targetId) {
      await requireTarget(userId, targetId);
      const [bank, overrides] = await Promise.all([
        api.getCareerBank(userId),
        db
          .select(overrideColumns)
          .from(careerOverrides)
          .where(and(eq(careerOverrides.userId, userId), eq(careerOverrides.targetId, targetId))),
      ]);
      const replaced = overrides.flatMap((o) =>
        o.action === 'replace' && o.itemId ? [o.itemId] : [],
      );
      const latest =
        replaced.length > 0
          ? await latestRevisionIds(db, userId, replaced)
          : new Map<string, string>();
      return resolveCareerBank(bank, overrides, latest);
    },
  };
  return api;
}
