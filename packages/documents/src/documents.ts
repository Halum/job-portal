import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@job-portal/db';
import {
  careerItems,
  careerRevisions,
  fileBytes,
  files,
  masterDocuments,
  type CareerItemKind,
  type FileKind,
  type MasterKind,
  type RevisionActor,
  type RevisionReason,
} from './schema';

export { FILE_KINDS, MASTER_KINDS, type FileKind, type MasterKind } from './schema';
export {
  CAREER_ITEM_KINDS,
  REVISION_ACTORS,
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
  skill: 60,
  skills: 20,
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
  skills: z.array(z.string().min(1).max(CAREER_LIMITS.skill)).max(CAREER_LIMITS.skills),
});
export type ExperiencePointValue = z.infer<typeof experiencePointValue>;

const short = z.string().min(1).max(CAREER_LIMITS.short);
const label = z.string().min(1).max(CAREER_LIMITS.skill);

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
  themes: z.array(label).max(CAREER_LIMITS.skills),
  skills: z.array(label).max(CAREER_LIMITS.skills),
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

/** One zod schema per item kind: import, edits, revisions and the MCP output all parse with it. */
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

/** Kinds with exactly one item per user: a write to them updates it. */
const SINGLETON_KINDS: readonly CareerItemKind[] = ['writing_style', 'contact'];

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

export class DocumentsError extends Error {
  constructor(
    readonly code: 'not_found' | 'unsupported_type' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentsError';
  }
}

export interface FileInfo {
  id: string;
  kind: FileKind;
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
  itemKind: CareerItemKind;
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
  reason: 'coaching' | 'enrichment' | 'user_edit';
  actor: RevisionActor;
}

export interface Documents {
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
  item: { kind: CareerItemKind; id: string },
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

export function createDocuments(db: Db): Documents {
  return {
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
      await ownedItem(db, userId, itemId);
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
  };
}
