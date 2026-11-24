import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userSchema, type User } from '@job-portal/accounts';
import type { Discovery } from '@job-portal/discovery';
import { RUN_STATUSES, type Pipeline } from '@job-portal/pipeline';

export interface ToolDeps {
  discovery: Discovery;
  pipeline: Pipeline;
}

const isoDate = z.string().describe('ISO 8601 timestamp, UTC');

const postingSchema = z.object({
  sourceId: z.string(),
  sourcePostingId: z.string(),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string(),
  postedAt: isoDate.nullable(),
  firstSeenAt: isoDate,
  lastSeenAt: isoDate,
});

const jobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  createdAt: isoDate,
  postings: z.array(postingSchema),
});

const runSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.enum(RUN_STATUSES),
  fetched: z.number(),
  newPostings: z.number(),
  errors: z.array(z.string()),
  errorCount: z.number().describe('Length of errors'),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const withDates = <T extends { postedAt: Date | null; firstSeenAt: Date; lastSeenAt: Date }>(
  p: T,
): Omit<T, 'postedAt' | 'firstSeenAt' | 'lastSeenAt'> & {
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
} => ({
  ...p,
  postedAt: iso(p.postedAt),
  firstSeenAt: p.firstSeenAt.toISOString(),
  lastSeenAt: p.lastSeenAt.toISOString(),
});

const jobOut = <J extends { createdAt: Date; postings: Parameters<typeof withDates>[0][] }>(
  j: J,
): Omit<J, 'createdAt' | 'postings'> & {
  createdAt: string;
  postings: ReturnType<typeof withDates>[];
} => ({ ...j, createdAt: j.createdAt.toISOString(), postings: j.postings.map(withDates) });

const text = (value: unknown): { type: 'text'; text: string } => ({
  type: 'text',
  text: JSON.stringify(value),
});

export function registerTools(mcp: McpServer, user: User, { discovery, pipeline }: ToolDeps): void {
  mcp.registerTool(
    'whoami',
    {
      description: 'Return the id, email and timezone of the authenticated user.',
      outputSchema: userSchema.shape,
    },
    () => ({ content: [text(user)], structuredContent: user }),
  );

  mcp.registerTool(
    'list_jobs',
    {
      description:
        'List stored Jobs with their postings, ordered and paged by Job id. Pass nextCursor back as cursor for the next page.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.uuid().optional().describe('The nextCursor of the previous page.'),
      },
      outputSchema: { jobs: z.array(jobSchema), nextCursor: z.string().nullable() },
    },
    async ({ limit, cursor }) => {
      const page = await discovery.listJobs(user.id, { limit, cursor });
      const out = {
        jobs: page.jobs.map(jobOut),
        nextCursor: page.nextCursor,
      };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'get_job',
    {
      description:
        'Get one Job with all its postings, including each posting as the source gave it.',
      inputSchema: { jobId: z.uuid() },
      outputSchema: {
        job: jobSchema.extend({ postings: z.array(postingSchema.extend({ raw: z.unknown() })) }),
      },
    },
    async ({ jobId }) => {
      const job = await discovery.getJob(user.id, jobId);
      if (!job) return { isError: true, content: [{ type: 'text', text: `No Job ${jobId}` }] };
      const out = {
        job: {
          ...job,
          createdAt: job.createdAt.toISOString(),
          postings: job.postings.map(withDates),
        },
      };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'get_run_history',
    {
      description:
        'List recent Runs, newest first: source, status, counts fetched and new postings, errors.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      outputSchema: { runs: z.array(runSchema) },
    },
    async ({ limit }) => {
      const runs = await pipeline.listRuns(user.id, limit ?? 20);
      const out = {
        runs: runs.map((r) => ({
          ...r,
          errorCount: r.errors.length,
          startedAt: r.startedAt.toISOString(),
          finishedAt: iso(r.finishedAt),
        })),
      };
      return { content: [text(out)], structuredContent: out };
    },
  );
}
