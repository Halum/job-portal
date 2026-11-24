import { and, asc, eq, sql } from 'drizzle-orm';
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
export type { CareerItemKind, RevisionActor, RevisionReason } from './schema';

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

/** A reviewed parse of a Master resume: Work experiences, each with its Experience points. */
export const careerBankImport = z.object({
  workExperiences: z
    .array(
      workExperienceValue.extend({
        points: z.array(experiencePointValue).max(CAREER_LIMITS.points),
      }),
    )
    .min(1)
    .max(CAREER_LIMITS.experiences),
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

/** The media type of an upload, decided from its content alone; null when the kind does not allow it. */
export function detectMediaType(kind: FileKind, filename: string, bytes: Buffer): string | null {
  if (kind === 'photo') {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    return null;
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // A DOCX is a zip with a word/document.xml entry; zip entry names are stored uncompressed.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return bytes.includes('word/document.xml', 0, 'latin1') ? DOCX : null;
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

export interface CareerBank {
  masterDocuments: { masterResume: FileInfo | null; masterCoverLetter: FileInfo | null };
  workExperiences: (WorkExperienceValue & {
    id: string;
    points: (ExperiencePointValue & { id: string })[];
  })[];
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

export interface Documents {
  /** Checks the content type and stores the file; a new upload of a kind never removes an older one. */
  storeFile: (userId: string, file: NewFile) => Promise<FileInfo>;
  /** The file and its bytes, or null when the id is unknown or belongs to another user. */
  getFile: (userId: string, id: string) => Promise<{ info: FileInfo; bytes: Buffer } | null>;
  /** Makes an uploaded file of that kind the current Master; older uploads stay. Another user's or unknown id: not_found. */
  registerMaster: (userId: string, kind: MasterKind, fileId: string) => Promise<FileInfo>;
  /** Adds the Work experiences of a reviewed parse after the existing ones, each write a Career bank revision (reason import). */
  importCareerBank: (
    userId: string,
    input: CareerBankImport,
    actor: RevisionActor,
  ) => Promise<{ workExperiences: number; experiencePoints: number }>;
  getCareerBank: (userId: string) => Promise<CareerBank>;
  /** The history of one item, oldest first. */
  listRevisions: (userId: string, itemId: string) => Promise<CareerRevision[]>;
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
      return db.transaction(async (tx) => {
        // One import at a time per user, so positions continue without gaps or duplicates.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${'documents.career:' + userId}))`,
        );
        const [last] = await tx
          .select({ position: careerItems.position })
          .from(careerItems)
          .where(and(eq(careerItems.userId, userId), eq(careerItems.kind, 'work_experience')))
          .orderBy(sql`${careerItems.position} desc`)
          .limit(1);
        let position = (last?.position ?? -1) + 1;
        let experiencePoints = 0;
        const revise = (
          itemKind: CareerItemKind,
          itemId: string,
          newValue: Record<string, unknown>,
        ) =>
          tx.insert(careerRevisions).values({
            userId,
            itemKind,
            itemId,
            oldValue: null,
            newValue,
            reason: 'import',
            actor,
          });
        for (const { points, ...value } of input.workExperiences) {
          const [item] = await tx
            .insert(careerItems)
            .values({ userId, kind: 'work_experience', position: position++, value })
            .returning({ id: careerItems.id });
          if (!item) throw new Error('career item insert returned no row');
          await revise('work_experience', item.id, value);
          for (const [i, point] of points.entries()) {
            const [row] = await tx
              .insert(careerItems)
              .values({
                userId,
                kind: 'experience_point',
                parentId: item.id,
                position: i,
                value: point,
              })
              .returning({ id: careerItems.id });
            if (!row) throw new Error('career item insert returned no row');
            await revise('experience_point', row.id, point);
            experiencePoints++;
          }
        }
        return { workExperiences: input.workExperiences.length, experiencePoints };
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
      const infoOf = (kind: MasterKind): FileInfo | null => {
        const m = masters.find((x) => x.kind === kind);
        return m ?? null;
      };
      const pointsOf = new Map<string, CareerBank['workExperiences'][number]['points']>();
      for (const item of items) {
        if (item.kind !== 'experience_point' || item.parentId === null) continue;
        const list = pointsOf.get(item.parentId) ?? [];
        list.push({ id: item.id, ...experiencePointValue.parse(item.value) });
        pointsOf.set(item.parentId, list);
      }
      return {
        masterDocuments: {
          masterResume: infoOf('master_resume'),
          masterCoverLetter: infoOf('master_cover_letter'),
        },
        workExperiences: items
          .filter((item) => item.kind === 'work_experience')
          .map((item) => ({
            id: item.id,
            ...workExperienceValue.parse(item.value),
            points: pointsOf.get(item.id) ?? [],
          })),
      };
    },

    async listRevisions(userId, itemId) {
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
