import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import {
  CAREER_EDIT_REASONS,
  CAREER_ITEM_KINDS,
  DocumentsError,
  ITEM_SOURCES,
  OVERRIDE_ACTIONS,
  OVERRIDE_ITEM_KINDS,
  REVISION_ITEM_KINDS,
  REVISION_REASONS,
  MASTER_KINDS,
  REVISION_ACTORS,
  careerBankImport,
  contactValue,
  savePacketInput,
  coverLetterParagraphValue,
  experiencePointValue,
  outlineSectionValue,
  resumeEntryValue,
  workExperienceValue,
  writingStyleValue,
  type CareerItem,
  type CareerOverride,
  type Documents,
  type FileInfo,
  type PacketSummary,
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

/** An item of the Career bank; the markers are there only when get_career_bank is asked for a Target. */
const stored = z.object({
  id: z.string(),
  hidden: z.boolean(),
  source: z.enum(ITEM_SOURCES).optional(),
  overrideId: z.string().nullable().optional(),
  stale: z.boolean().optional(),
});

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

const overrideOut = {
  override: z.object({
    id: z.string(),
    targetId: z.string(),
    action: z.enum(OVERRIDE_ACTIONS),
    itemKind: z.enum(OVERRIDE_ITEM_KINDS),
    itemId: z.string().nullable(),
    parentId: z.string().nullable(),
    value: z.record(z.string(), z.unknown()).nullable(),
    baseRevisionId: z.string().nullable(),
    createdAt: z.string().describe('ISO 8601 timestamp, UTC'),
  }),
};

const overrideJson = (o: CareerOverride) =>
  ok({ override: { ...o, createdAt: o.createdAt.toISOString() } });

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

const packetOut = z.object({
  id: z.string(),
  jobId: z.string(),
  targetId: z.string(),
  version: z.number().describe('1 for the first preparation of the Job, then counting up'),
  sent: z.boolean().describe('true for the one version marked as sent'),
  sentAt: z.string().nullable().describe('ISO 8601 timestamp, UTC'),
  resumePdfFileId: z.string().describe('download with GET /files/<id>'),
  letterPdfFileId: z.string().describe('download with GET /files/<id>'),
  resumePages: z.number(),
  letterPages: z.number(),
  resumeOverCap: z.boolean().describe('longer than 2 pages: trim and save again'),
  letterOverCap: z.boolean().describe('longer than 1 page: trim and save again'),
  createdAt: z.string().describe('ISO 8601 timestamp, UTC'),
});

const packetJson = <T extends PacketSummary>(p: T) => ({
  ...p,
  sentAt: p.sentAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
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
        return failed(err, 'register_master_document');
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
        'Read the whole Career bank: the current Master files, Work experiences each with Experience points, Resume entries, the Cover letter outline sections each with paragraphs, the Writing style profile and the contact details (null when not set yet). Hidden items are included with hidden true. With targetId it returns what that Target sees instead: the Career bank items that are not hidden there, minus the Target hides, with the Target replacements and Target-only additions, every item marked source inherited, replaced, added or hidden (hidden ones are the Target hides and what hangs under them; use only the others), overrideId for the ones an override made, and stale true on a replacement made against an older version of the item than the Career bank has now (tell the user the Career bank version changed and offer to update the Target). An unknown or foreign targetId is refused.',
      inputSchema: { targetId: z.uuid().optional() },
      outputSchema: careerBankOut,
    },
    async ({ targetId }) => {
      let bank;
      try {
        bank =
          targetId === undefined
            ? await documents.getCareerBank(user.id)
            : await documents.getTargetCareerBank(user.id, targetId);
      } catch (err) {
        return failed(err, 'get_career_bank');
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
        reason: z.enum(CAREER_EDIT_REASONS),
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
    'set_career_override',
    {
      description:
        "Change the Career bank for one Target only (a Career bank override). action hide: itemId of a Work experience, Experience point, Resume entry or Cover letter paragraph. action replace: itemId plus value, the whole new item value in the item's own shape (same as upsert_career_item). action add: itemKind (work_experience, experience_point, resume_entry or cover_letter_paragraph), value, and parentId for an Experience point (a Work experience: a Career bank one or one this Target added) or a Cover letter paragraph (an outline section); pass overrideId to edit an item the Target added. Setting an item again changes its hide or replace in place. Every call records a Career bank revision of item kind override with the reason you give (list_career_revisions with the override id). A replace remembers the item's current version, so a later Career bank edit of that item shows the replacement as stale in get_career_bank. Unknown or foreign Target and item ids are refused.",
      inputSchema: {
        targetId: z.uuid(),
        action: z.enum(OVERRIDE_ACTIONS),
        itemId: z.uuid().optional(),
        itemKind: z.enum(OVERRIDE_ITEM_KINDS).optional(),
        parentId: z.uuid().optional(),
        overrideId: z.uuid().optional(),
        value: z.record(z.string(), z.unknown()).optional(),
        reason: z.enum(CAREER_EDIT_REASONS),
        actor: actorIn,
      },
      outputSchema: overrideOut,
    },
    async (input) => {
      try {
        return overrideJson(await documents.setOverride(user.id, input));
      } catch (err) {
        return failed(err, 'set_career_override');
      }
    },
  );

  mcp.registerTool(
    'clear_career_override',
    {
      description:
        'Remove one Career bank override (its overrideId is on the item in get_career_bank with a targetId, or in the answer of set_career_override), so the Target follows the Career bank again for that item. Points added under a removed Target-only Work experience go with it. Records a revision of item kind override with reason restore; what the override held stays in its history.',
      inputSchema: { overrideId: z.uuid(), actor: actorIn },
      outputSchema: overrideOut,
    },
    async ({ overrideId, actor }) => {
      try {
        return overrideJson(await documents.clearOverride(user.id, overrideId, actor));
      } catch (err) {
        return failed(err, 'clear_career_override');
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
            itemKind: z.enum(REVISION_ITEM_KINDS),
            itemId: z.string(),
            oldValue: z.record(z.string(), z.unknown()).nullable(),
            newValue: z.record(z.string(), z.unknown()),
            reason: z.enum(REVISION_REASONS),
            actor: z.enum(REVISION_ACTORS),
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

  mcp.registerTool(
    'save_application_packet',
    {
      description:
        "Save a prepared resume and cover letter for one Job as a new Application packet version, rendered to two PDFs. targetId is the Target you are applying under (any Target of the user; the Job's tags are only a default to suggest). resume and letter are the structured content (the resume's experiences newest first, points as plain lines; the letter's salutation, paragraphs, signOff, signature). sources says where each line came from, in the same shape and order as the content: sources.resume.experiences[i] {itemIds: the Work experience id, points: [{itemIds}]} for each point, education, skills, languages and certificates {itemIds} per entry, sources.letter.paragraphs[i] {itemIds} per paragraph. Use the ids get_career_bank returns for that Target (with targetId): a Career bank item id, or the override id of an item the Target added; a merged line lists every source. A paragraph you drafted because nothing fit has no itemIds and isNew true. An id that is not in that Target career bank (unknown, another user's, hidden for the Target) is refused and nothing is saved. The server records each source's revision and override id. gaps are the Requirement gaps, questionsAsked the Enrichment questions asked. Returns the version, page counts and over-cap flags (resume over 2 pages, letter over 1): when one is set, trim and save again. Download the PDFs with GET /files/<id>.",
      inputSchema: savePacketInput.shape,
      outputSchema: { packet: packetOut },
    },
    async (input) => {
      try {
        return ok({ packet: packetJson(await documents.savePacket(user.id, input)) });
      } catch (err) {
        return failed(err, 'save_application_packet');
      }
    },
  );

  mcp.registerTool(
    'list_application_packets',
    {
      description:
        "The Application packet versions of one Job, oldest first, with page counts, over-cap flags, PDF file ids and which one is marked sent. The Job must be the user's.",
      inputSchema: { jobId: z.uuid() },
      outputSchema: { packets: z.array(packetOut) },
    },
    async ({ jobId }) => {
      try {
        return ok({ packets: (await documents.listPackets(user.id, jobId)).map(packetJson) });
      } catch (err) {
        return failed(err, 'list_application_packets');
      }
    },
  );

  mcp.registerTool(
    'get_application_packet',
    {
      description:
        'One Application packet version of a Job (the newest when version is left out): the structured resume and letter, both as Markdown, the sources of every line with their revisions and override ids, the Requirement gaps, the Enrichment questions asked, the page counts and the two PDF file ids (download with GET /files/<id>).',
      inputSchema: { jobId: z.uuid(), version: z.number().int().min(1).optional() },
      outputSchema: {
        packet: packetOut.extend({
          resume: z.record(z.string(), z.unknown()),
          letter: z.record(z.string(), z.unknown()),
          sources: z.record(z.string(), z.unknown()),
          gaps: z.array(z.string()),
          questionsAsked: z.array(z.string()),
          resumeMarkdown: z.string(),
          letterMarkdown: z.string(),
        }),
      },
    },
    async ({ jobId, version }) => {
      try {
        return ok({ packet: packetJson(await documents.getPacket(user.id, jobId, version)) });
      } catch (err) {
        return failed(err, 'get_application_packet');
      }
    },
  );

  mcp.registerTool(
    'mark_packet_sent',
    {
      description:
        'Mark the Application packet version you actually sent. A Job has at most one sent version: marking another one moves the mark (in one step). An unknown version leaves the mark where it was.',
      inputSchema: { jobId: z.uuid(), version: z.number().int().min(1) },
      outputSchema: { packet: packetOut },
    },
    async ({ jobId, version }) => {
      try {
        return ok({ packet: packetJson(await documents.markPacketSent(user.id, jobId, version)) });
      } catch (err) {
        return failed(err, 'mark_packet_sent');
      }
    },
  );
}
