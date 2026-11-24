import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import {
  DocumentsError,
  MASTER_KINDS,
  careerBankImport,
  experiencePointValue,
  workExperienceValue,
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

const careerBankOut = {
  masterDocuments: z.object({
    masterResume: fileOut.nullable(),
    masterCoverLetter: fileOut.nullable(),
  }),
  workExperiences: z.array(
    workExperienceValue.extend({
      id: z.string(),
      points: z.array(experiencePointValue.extend({ id: z.string() })),
    }),
  ),
};

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
        'Import a reviewed parse of the Master resume: Work experiences (role, organisation, start, end or null while current, place), each with Experience points (text, skills). Only call it after the user reviewed the parse. The items are added after the ones already stored (this is not a replace), and each write is recorded as a Career bank revision with reason import.',
      inputSchema: careerBankImport.shape,
      outputSchema: { workExperiences: z.number(), experiencePoints: z.number() },
    },
    async (input) => {
      try {
        return ok(await documents.importCareerBank(user.id, input, 'skill'));
      } catch (err) {
        logger.error({ err }, 'save_career_bank failed');
        return refusal('save_career_bank failed');
      }
    },
  );

  mcp.registerTool(
    'get_career_bank',
    {
      description:
        'Read the Career bank: the current Master resume and Master cover letter files, and the Work experiences in order, each with its Experience points in order.',
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
      });
    },
  );
}
