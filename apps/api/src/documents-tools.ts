import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import {
  CAREER_ITEM_KINDS,
  DocumentsError,
  MASTER_KINDS,
  REVISION_ACTORS,
  careerBankImport,
  contactValue,
  coverLetterParagraphValue,
  experiencePointValue,
  outlineSectionValue,
  resumeEntryValue,
  workExperienceValue,
  writingStyleValue,
  type CareerItem,
  type Documents,
  type FileInfo,
} from '@job-portal/documents';
import type { Logger } from '@job-portal/shared';

const fileOut = z.object({
  id: z.string(),
  kind: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number(),
  createdAt: z.string().describe('ISO 8601 timestamp, UTC'),
});

const stored = z.object({ id: z.string(), hidden: z.boolean() });

const careerBankOut = {
  masterDocuments: z.object({
    masterResume: fileOut.nullable(),
    masterCoverLetter: fileOut.nullable(),
  }),
  workExperiences: z.array(
    stored.extend(workExperienceValue.shape).extend({
      points: z.array(stored.extend(experiencePointValue.shape)),
    }),
  ),
  resumeEntries: z.array(stored.and(resumeEntryValue)),
  coverLetterOutline: z.array(
    stored.extend(outlineSectionValue.shape).extend({
      paragraphs: z.array(stored.extend(coverLetterParagraphValue.shape)),
    }),
  ),
  writingStyle: stored.extend(writingStyleValue.shape).nullable(),
  contact: stored.extend(contactValue.shape).nullable(),
};

const itemOut = {
  item: z.object({
    id: z.string(),
    kind: z.enum(CAREER_ITEM_KINDS),
    parentId: z.string().nullable(),
    hidden: z.boolean(),
    value: z.record(z.string(), z.unknown()),
  }),
};
const actorIn = z
  .enum(REVISION_ACTORS)
  .default('skill')
  .describe('user when the user dictated the change, skill when you made it');

const ok = (out: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }],
  structuredContent: out,
});
const refusal = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: message }],
});

const fileJson = (f: FileInfo) => ({ ...f, createdAt: f.createdAt.toISOString() });

export function registerDocumentsTools(
  mcp: McpServer,
  user: User,
  documents: Documents,
  logger: Logger,
): void {
  const failed = (err: unknown, tool: string) => {
    if (err instanceof DocumentsError) return refusal(err.message);
    logger.error({ err }, `${tool} failed`);
    return refusal(`${tool} failed`);
  };

  mcp.registerTool(
    'register_master_document',
    {
      description:
        "Mark an uploaded file as the current Master resume or Master cover letter. Upload the file first with POST /files?kind=master_resume|master_cover_letter&filename=... (raw body, same bearer token) and pass the returned id here. Older uploads are kept. An unknown file id, another user's file or a file uploaded as another kind is refused.",
      inputSchema: { kind: z.enum(MASTER_KINDS), fileId: z.uuid() },
      outputSchema: { file: fileOut },
    },
    async ({ kind, fileId }) => {
      try {
        return ok({ file: fileJson(await documents.registerMaster(user.id, kind, fileId)) });
      } catch (err) {
        if (err instanceof DocumentsError) return refusal(err.message);
        logger.error({ err }, 'register_master_document failed');
        return refusal('register_master_document failed');
      }
    },
  );

  mcp.registerTool(
    'save_career_bank',
    {
      description:
        "Import a reviewed parse of the Master resume and Master cover letter: Work experiences (role, organisation, start, end or null while current, place) with Experience points (text, skills); resumeEntries (kind education, skill, language or certificate, with that kind's fields); coverLetterOutline (sections in the user's order, each with paragraphs: text, themes, skills); writingStyle; contact (name, address, phone, email, links, photoFileId of an uploaded photo or null). Every part is optional but not all of them. Only call it after the user reviewed the parse. Items are added after the ones already stored (not a replace); a stored writingStyle or contact is updated. Each write is a Career bank revision with reason import.",
      inputSchema: careerBankImport.shape,
      outputSchema: {
        workExperiences: z.number(),
        experiencePoints: z.number(),
        resumeEntries: z.number(),
        outlineSections: z.number(),
        coverLetterParagraphs: z.number(),
        writingStyle: z.boolean(),
        contact: z.boolean(),
      },
    },
    async (input) => {
      try {
        return ok({ ...(await documents.importCareerBank(user.id, input, 'skill')) });
      } catch (err) {
        return failed(err, 'save_career_bank');
      }
    },
  );

  mcp.registerTool(
    'get_career_bank',
    {
      description:
        'Read the whole Career bank: the current Master files, Work experiences each with Experience points, Resume entries, the Cover letter outline sections each with paragraphs, the Writing style profile and the contact details (null when not set yet). Hidden items are included with hidden true.',
      outputSchema: careerBankOut,
    },
    async () => {
      let bank;
      try {
        bank = await documents.getCareerBank(user.id);
      } catch (err) {
        logger.error({ err }, 'get_career_bank failed');
        return refusal('get_career_bank failed');
      }
      return ok({
        masterDocuments: {
          masterResume: bank.masterDocuments.masterResume
            ? fileJson(bank.masterDocuments.masterResume)
            : null,
          masterCoverLetter: bank.masterDocuments.masterCoverLetter
            ? fileJson(bank.masterDocuments.masterCoverLetter)
            : null,
        },
        workExperiences: bank.workExperiences,
        resumeEntries: bank.resumeEntries,
        coverLetterOutline: bank.coverLetterOutline,
        writingStyle: bank.writingStyle,
        contact: bank.contact,
      });
    },
  );

  const itemJson = (item: CareerItem) => ok({ item });

  mcp.registerTool(
    'upsert_career_item',
    {
      description:
        "Add or edit one Career bank item. itemKind and its value: work_experience {role, organisation, start, end|null, place|null}; experience_point {text, skills} with parentId = its Work experience; resume_entry {kind: education|skill|language|certificate, ...fields of that kind}; outline_section {name}; cover_letter_paragraph {text, themes, skills} with parentId = its outline section; writing_style {tone, sentenceNotes, wordsUsed, wordsAvoided, salutation, signOff} (one per user, edited in place); contact {name, address, phone, email, links, photoFileId|null} (one per user; photoFileId is an uploaded photo). Pass itemId to edit, leave it out to add. An edit replaces the whole value. Every call records a Career bank revision with the reason you give. Another user's or unknown ids are refused.",
      inputSchema: {
        itemKind: z.enum(CAREER_ITEM_KINDS),
        itemId: z.uuid().optional(),
        parentId: z.uuid().optional(),
        value: z.record(z.string(), z.unknown()),
        reason: z.enum(['coaching', 'enrichment', 'user_edit']),
        actor: actorIn,
      },
      outputSchema: itemOut,
    },
    async (input) => {
      try {
        return itemJson(await documents.upsertItem(user.id, input));
      } catch (err) {
        return failed(err, 'upsert_career_item');
      }
    },
  );

  mcp.registerTool(
    'hide_career_item',
    {
      description:
        'Delete a Career bank item the safe way: it is hidden and a revision with reason hide is recorded, so old Application packets still show it and it can be restored. Not for the Writing style or the contact details.',
      inputSchema: { itemId: z.uuid(), actor: actorIn },
      outputSchema: itemOut,
    },
    async ({ itemId, actor }) => {
      try {
        return itemJson(await documents.hideItem(user.id, itemId, actor));
      } catch (err) {
        return failed(err, 'hide_career_item');
      }
    },
  );

  mcp.registerTool(
    'restore_career_item',
    {
      description:
        "Without revisionId: unhide a hidden item. With revisionId (from list_career_revisions of the same item): set the item back to that revision's text and unhide it. Both record a new revision with reason restore; history only grows.",
      inputSchema: { itemId: z.uuid(), revisionId: z.uuid().optional(), actor: actorIn },
      outputSchema: itemOut,
    },
    async ({ itemId, revisionId, actor }) => {
      try {
        return itemJson(await documents.restoreItem(user.id, itemId, actor, revisionId));
      } catch (err) {
        return failed(err, 'restore_career_item');
      }
    },
  );

  mcp.registerTool(
    'list_career_revisions',
    {
      description:
        'The history of one Career bank item, oldest first: old text, new text, reason (import, coaching, enrichment, user_edit, hide, restore), actor and time.',
      inputSchema: { itemId: z.uuid() },
      outputSchema: {
        revisions: z.array(
          z.object({
            id: z.string(),
            itemKind: z.enum(CAREER_ITEM_KINDS),
            itemId: z.string(),
            oldValue: z.record(z.string(), z.unknown()).nullable(),
            newValue: z.record(z.string(), z.unknown()),
            reason: z.string(),
            actor: z.string(),
            createdAt: z.string().describe('ISO 8601 timestamp, UTC'),
          }),
        ),
      },
    },
    async ({ itemId }) => {
      try {
        const revisions = await documents.listRevisions(user.id, itemId);
        return ok({
          revisions: revisions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        });
      } catch (err) {
        return failed(err, 'list_career_revisions');
      }
    },
  );
}
