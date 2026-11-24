import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import type { Mail } from '@job-portal/mail';

export function registerMailTools(
  mcp: McpServer,
  user: User,
  mail: Pick<Mail, 'listUnmatched'>,
): void {
  mcp.registerTool(
    'list_unmatched_mails',
    {
      description:
        'List job-like mails from the Gmail inbox that matched none of your Jobs (a reply to an application you never tracked, an unknown recruiter), so nothing is dropped silently. Each shows the sender, subject, a one-sentence summary where the AI read it, and when it arrived. Ordered and paged by id; pass nextCursor back as cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.uuid().optional().describe('The nextCursor of the previous page.'),
      },
      outputSchema: {
        items: z.array(
          z.object({
            id: z.string(),
            messageId: z.string(),
            from: z.string(),
            subject: z.string(),
            summary: z.string(),
            receivedAt: z.string().describe('ISO 8601 timestamp, UTC'),
          }),
        ),
        nextCursor: z.string().nullable(),
      },
    },
    async ({ limit, cursor }) => {
      const page = await mail.listUnmatched(user.id, { limit, cursor });
      const out = {
        items: page.items.map((m) => ({ ...m, receivedAt: m.receivedAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );
}
