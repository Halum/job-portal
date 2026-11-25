import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@job-portal/db';
import { DocumentsError } from './errors';
import {
  letterContent,
  letterMarkdown,
  renderLetterPdf,
  renderResumePdf,
  resumeContent,
  resumeMarkdown,
} from './render';
import { applicationPackets, fileBytes, files, type CareerItemKind } from './schema';
import type { ItemSource, TargetCareerBank } from './resolve';

// The sources of every line of a packet, named by the ids the Target career bank shows (get_career_bank with targetId):
// the Career bank item id, or the override id for a line a Target added. The server adds each item's revision.
const sourceFields = {
  itemIds: z.array(z.uuid()).max(10).default([]),
  // A letter paragraph drafted because nothing fit: no source, flagged as new.
  isNew: z.boolean().default(false),
};
const needsSource = (s: { itemIds: string[]; isNew: boolean }) => s.itemIds.length > 0 || s.isNew;
const NEEDS_SOURCE = 'a line without source items must be flagged isNew';
const line = z.object(sourceFields).refine(needsSource, NEEDS_SOURCE);

export const packetSources = z.object({
  resume: z.object({
    experiences: z
      .array(
        z
          .object({ ...sourceFields, points: z.array(line).max(20) })
          .refine(needsSource, NEEDS_SOURCE),
      )
      .max(30),
    education: z.array(line).max(20).default([]),
    skills: z.array(line).max(60).default([]),
    languages: z.array(line).max(20).default([]),
    certificates: z.array(line).max(30).default([]),
  }),
  letter: z.object({ paragraphs: z.array(line).min(1).max(20) }),
});

export const savePacketInput = z.object({
  jobId: z.uuid(),
  targetId: z.uuid(),
  resume: resumeContent,
  letter: letterContent,
  sources: packetSources,
  gaps: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  questionsAsked: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});
export type SavePacketInput = z.input<typeof savePacketInput>;

/** One source of a line as stored: the item, where the Target got it from, and the revision it had when used. */
export interface PacketSourceRef {
  itemId: string;
  kind: CareerItemKind;
  source: Exclude<ItemSource, 'hidden'>;
  /** The newest revision of the item (of the override, for an item the Target added) when the packet was saved. */
  revisionId: string | null;
  overrideId: string | null;
}
export interface PacketLineSources {
  items: PacketSourceRef[];
  isNew: boolean;
}
export interface PacketSources {
  resume: {
    experiences: (PacketLineSources & { points: PacketLineSources[] })[];
    education: PacketLineSources[];
    skills: PacketLineSources[];
    languages: PacketLineSources[];
    certificates: PacketLineSources[];
  };
  letter: { paragraphs: PacketLineSources[] };
}

export interface PacketSummary {
  id: string;
  jobId: string;
  targetId: string;
  version: number;
  sent: boolean;
  sentAt: Date | null;
  resumePdfFileId: string;
  letterPdfFileId: string;
  resumePages: number;
  letterPages: number;
  resumeOverCap: boolean;
  letterOverCap: boolean;
  createdAt: Date;
}

export interface Packet extends PacketSummary {
  resume: Record<string, unknown>;
  letter: Record<string, unknown>;
  sources: PacketSources;
  gaps: string[];
  questionsAsked: string[];
  resumeMarkdown: string;
  letterMarkdown: string;
}

export interface PacketsOverview {
  count: number;
  currentVersion: number | null;
  sentVersion: number | null;
}

export interface PacketOps {
  /** Renders both PDFs and stores a new version; the sources must all be in that Target's career bank. */
  savePacket: (userId: string, input: SavePacketInput) => Promise<PacketSummary>;
  /** The versions of one Job, oldest first. */
  listPackets: (userId: string, jobId: string) => Promise<PacketSummary[]>;
  /** One version with its content, sources and Markdown; the newest when no version is given. */
  getPacket: (userId: string, jobId: string, version?: number) => Promise<Packet>;
  /** Moves the sent mark of the Job to this version, in one transaction. */
  markPacketSent: (userId: string, jobId: string, version: number) => Promise<PacketSummary>;
  /** Count, newest version and sent version of a Job's packets; for the Job already checked by the caller. */
  packetsOverview: (userId: string, jobId: string) => Promise<PacketsOverview>;
}

export interface PacketContext {
  db: Db;
  requireTarget: (userId: string, targetId: string) => Promise<void>;
  requireJob: (userId: string, jobId: string) => Promise<void>;
  targetBank: (userId: string, targetId: string) => Promise<TargetCareerBank>;
  latestRevisions: (userId: string, itemIds: string[]) => Promise<Map<string, string>>;
}

const summaryColumns = {
  id: applicationPackets.id,
  jobId: applicationPackets.jobId,
  targetId: applicationPackets.targetId,
  version: applicationPackets.version,
  sent: applicationPackets.sent,
  sentAt: applicationPackets.sentAt,
  resumePdfFileId: applicationPackets.resumePdfFileId,
  letterPdfFileId: applicationPackets.letterPdfFileId,
  resumePages: applicationPackets.resumePages,
  letterPages: applicationPackets.letterPages,
  resumeOverCap: applicationPackets.resumeOverCap,
  letterOverCap: applicationPackets.letterOverCap,
  createdAt: applicationPackets.createdAt,
};

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One writer at a time per Job's packets: the next version and the sent mark are decided under it. */
const lockPackets = (tx: Tx, userId: string, jobId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${'documents.packets:' + userId + ':' + jobId}))`,
  );

interface Usable {
  kind: CareerItemKind;
  source: Exclude<ItemSource, 'hidden'>;
  overrideId: string | null;
}

/** Every item a preparation may cite: what the Target sees, minus the hidden ones and what hangs under them. */
function usableItems(bank: TargetCareerBank): Map<string, Usable> {
  const usable = new Map<string, Usable>();
  const add = (
    kind: CareerItemKind,
    item: { id: string; source: ItemSource; overrideId: string | null; hidden: boolean },
  ) => {
    if (item.hidden || item.source === 'hidden') return;
    usable.set(item.id, { kind, source: item.source, overrideId: item.overrideId });
  };
  for (const we of bank.workExperiences) {
    add('work_experience', we);
    for (const p of we.points) add('experience_point', p);
  }
  for (const e of bank.resumeEntries) add('resume_entry', e);
  for (const s of bank.coverLetterOutline) {
    add('outline_section', s);
    for (const p of s.paragraphs) add('cover_letter_paragraph', p);
  }
  if (bank.writingStyle) add('writing_style', bank.writingStyle);
  if (bank.contact) add('contact', bank.contact);
  return usable;
}

const same = (name: string, got: number, want: number) => {
  if (got !== want) {
    throw new DocumentsError(
      'invalid_argument',
      `sources.${name} has ${String(got)} entries but the content has ${String(want)}`,
    );
  }
};

export function createPacketOps(ctx: PacketContext): PacketOps {
  const { db } = ctx;

  const summary = async (userId: string, jobId: string, version: number) => {
    const [row] = await db
      .select(summaryColumns)
      .from(applicationPackets)
      .where(
        and(
          eq(applicationPackets.userId, userId),
          eq(applicationPackets.jobId, jobId),
          eq(applicationPackets.version, version),
        ),
      );
    if (!row) throw new DocumentsError('not_found', 'no such Application packet');
    return row;
  };

  return {
    async savePacket(userId, raw) {
      const parsed = savePacketInput.safeParse(raw);
      if (!parsed.success) {
        throw new DocumentsError(
          'invalid_argument',
          `invalid packet: ${z.prettifyError(parsed.error)}`,
        );
      }
      const input = parsed.data;
      await ctx.requireTarget(userId, input.targetId);
      await ctx.requireJob(userId, input.jobId);

      const { resume, letter, sources } = input;
      same('resume.experiences', sources.resume.experiences.length, resume.experiences.length);
      resume.experiences.forEach((e, i) => {
        same(
          `resume.experiences[${String(i)}].points`,
          sources.resume.experiences[i]?.points.length ?? 0,
          e.points.length,
        );
      });
      same('resume.education', sources.resume.education.length, resume.education.length);
      same('resume.skills', sources.resume.skills.length, resume.skills.length);
      same('resume.languages', sources.resume.languages.length, resume.languages.length);
      same('resume.certificates', sources.resume.certificates.length, resume.certificates.length);
      same('letter.paragraphs', sources.letter.paragraphs.length, letter.paragraphs.length);

      const bank = await ctx.targetBank(userId, input.targetId);
      const usable = usableItems(bank);
      const cited = new Set<string>();
      const lines: { itemIds: string[] }[] = [
        ...sources.resume.experiences,
        ...sources.resume.experiences.flatMap((e) => e.points),
        ...sources.resume.education,
        ...sources.resume.skills,
        ...sources.resume.languages,
        ...sources.resume.certificates,
        ...sources.letter.paragraphs,
      ];
      for (const l of lines) {
        for (const id of l.itemIds) {
          if (!usable.has(id)) {
            throw new DocumentsError('not_found', `item ${id} is not in that Target career bank`);
          }
          cited.add(id);
        }
      }
      const revisions = await ctx.latestRevisions(userId, [...cited]);
      const lineOf = (l: { itemIds: string[]; isNew: boolean }): PacketLineSources => ({
        isNew: l.isNew,
        items: l.itemIds.map((itemId) => {
          const u = usable.get(itemId);
          if (!u) throw new Error('checked above');
          return {
            itemId,
            kind: u.kind,
            source: u.source,
            revisionId: revisions.get(itemId) ?? null,
            overrideId: u.overrideId,
          };
        }),
      });
      const stored: PacketSources = {
        resume: {
          experiences: sources.resume.experiences.map((e) => ({
            ...lineOf(e),
            points: e.points.map(lineOf),
          })),
          education: sources.resume.education.map(lineOf),
          skills: sources.resume.skills.map(lineOf),
          languages: sources.resume.languages.map(lineOf),
          certificates: sources.resume.certificates.map(lineOf),
        },
        letter: { paragraphs: sources.letter.paragraphs.map(lineOf) },
      };

      // The photo of the Target's contact details, when it has one.
      const photoId =
        bank.contact && typeof (bank.contact as { photoFileId?: unknown }).photoFileId === 'string'
          ? (bank.contact as { photoFileId: string }).photoFileId
          : null;
      const photo = photoId ? await photoBytes(db, userId, photoId) : undefined;
      const [resumePdf, letterPdf] = await Promise.all([
        renderResumePdf(resume, photo ? { photo } : {}),
        renderLetterPdf(letter),
      ]);

      return db.transaction(async (tx) => {
        await lockPackets(tx, userId, input.jobId);
        const [latest] = await tx
          .select({ version: applicationPackets.version })
          .from(applicationPackets)
          .where(
            and(eq(applicationPackets.userId, userId), eq(applicationPackets.jobId, input.jobId)),
          )
          .orderBy(desc(applicationPackets.version))
          .limit(1);
        const version = (latest?.version ?? 0) + 1;
        const storePdf = async (kind: 'resume_pdf' | 'letter_pdf', bytes: Buffer) => {
          const [file] = await tx
            .insert(files)
            .values({
              userId,
              kind,
              filename: `${kind === 'resume_pdf' ? 'resume' : 'letter'}-v${String(version)}.pdf`,
              mediaType: 'application/pdf',
              size: bytes.length,
            })
            .returning({ id: files.id });
          if (!file) throw new Error('file insert returned no row');
          await tx.insert(fileBytes).values({ fileId: file.id, bytes });
          return file.id;
        };
        const resumePdfFileId = await storePdf('resume_pdf', resumePdf.pdf);
        const letterPdfFileId = await storePdf('letter_pdf', letterPdf.pdf);
        const [row] = await tx
          .insert(applicationPackets)
          .values({
            userId,
            jobId: input.jobId,
            targetId: input.targetId,
            version,
            resume,
            letter,
            sources: stored as unknown as Record<string, unknown>,
            gaps: input.gaps,
            questionsAsked: input.questionsAsked,
            resumePdfFileId,
            letterPdfFileId,
            resumePages: resumePdf.pages,
            letterPages: letterPdf.pages,
            resumeOverCap: resumePdf.overCap,
            letterOverCap: letterPdf.overCap,
          })
          .returning(summaryColumns);
        if (!row) throw new Error('packet insert returned no row');
        return row;
      });
    },

    async listPackets(userId, jobId) {
      await ctx.requireJob(userId, jobId);
      return db
        .select(summaryColumns)
        .from(applicationPackets)
        .where(and(eq(applicationPackets.userId, userId), eq(applicationPackets.jobId, jobId)))
        .orderBy(asc(applicationPackets.version));
    },

    async getPacket(userId, jobId, version) {
      await ctx.requireJob(userId, jobId);
      const [row] = await db
        .select({
          ...summaryColumns,
          resume: applicationPackets.resume,
          letter: applicationPackets.letter,
          sources: applicationPackets.sources,
          gaps: applicationPackets.gaps,
          questionsAsked: applicationPackets.questionsAsked,
        })
        .from(applicationPackets)
        .where(
          and(
            eq(applicationPackets.userId, userId),
            eq(applicationPackets.jobId, jobId),
            version === undefined ? undefined : eq(applicationPackets.version, version),
          ),
        )
        .orderBy(desc(applicationPackets.version))
        .limit(1);
      if (!row) throw new DocumentsError('not_found', 'no such Application packet');
      return {
        ...row,
        sources: row.sources as unknown as PacketSources,
        resumeMarkdown: resumeMarkdown(resumeContent.parse(row.resume)),
        letterMarkdown: letterMarkdown(letterContent.parse(row.letter)),
      };
    },

    async markPacketSent(userId, jobId, version) {
      await ctx.requireJob(userId, jobId);
      await db.transaction(async (tx) => {
        await lockPackets(tx, userId, jobId);
        await tx
          .update(applicationPackets)
          .set({ sent: false, sentAt: null })
          .where(
            and(
              eq(applicationPackets.userId, userId),
              eq(applicationPackets.jobId, jobId),
              eq(applicationPackets.sent, true),
            ),
          );
        const marked = await tx
          .update(applicationPackets)
          .set({ sent: true, sentAt: new Date() })
          .where(
            and(
              eq(applicationPackets.userId, userId),
              eq(applicationPackets.jobId, jobId),
              eq(applicationPackets.version, version),
            ),
          )
          .returning({ id: applicationPackets.id });
        // Throwing rolls back the unmark: an unknown version leaves the old mark where it was.
        if (marked.length === 0)
          throw new DocumentsError('not_found', 'no such Application packet');
      });
      return summary(userId, jobId, version);
    },

    async packetsOverview(userId, jobId) {
      const rows = await db
        .select({ version: applicationPackets.version, sent: applicationPackets.sent })
        .from(applicationPackets)
        .where(and(eq(applicationPackets.userId, userId), eq(applicationPackets.jobId, jobId)));
      const versions = rows.map((r) => r.version);
      return {
        count: rows.length,
        currentVersion: versions.length > 0 ? Math.max(...versions) : null,
        sentVersion: rows.find((r) => r.sent)?.version ?? null,
      };
    },
  };
}

async function photoBytes(db: Db, userId: string, fileId: string): Promise<Buffer | undefined> {
  const [row] = await db
    .select({ bytes: fileBytes.bytes })
    .from(fileBytes)
    .innerJoin(files, eq(files.id, fileBytes.fileId))
    .where(and(eq(files.id, fileId), eq(files.userId, userId), eq(files.kind, 'photo')));
  return row?.bytes;
}
