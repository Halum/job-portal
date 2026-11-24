import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userSchema, type User } from '@job-portal/accounts';
import { DISCOVERY_STATES, type Discovery } from '@job-portal/discovery';
import { criteriaPatchSchema, criteriaSchema, type Matching } from '@job-portal/matching';
import { RUN_STATUSES, type Pipeline } from '@job-portal/pipeline';

export interface ToolDeps {
  discovery: Discovery;
  matching: Matching;
  pipeline: Pipeline;
}

const isoDate = z.string().describe('ISO 8601 timestamp, UTC');

const postingSchema = z.object({
  id: z.string(),
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
  discoveryState: z.enum(DISCOVERY_STATES),
  createdAt: isoDate,
  postings: z.array(postingSchema),
});

const runSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.enum(RUN_STATUSES),
  fetched: z.number(),
  newPostings: z.number(),
  prerankPassed: z.number().describe('Job and Target pairs that passed the filters and prerank'),
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

const targetSchema = z.object({
  id: z.string(),
  name: z.string(),
  paused: z.boolean(),
  criteria: criteriaSchema.describe(
    'Fields set on this Target; null means inherit the Global default',
  ),
  resolved: criteriaSchema.describe(
    'What the Target uses after falling back to the Global defaults',
  ),
});

const failure = (
  err: unknown,
  fallback: string,
): { isError: true; content: { type: 'text'; text: string }[] } => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : fallback }],
});

export function registerTools(
  mcp: McpServer,
  user: User,
  { discovery, matching, pipeline }: ToolDeps,
): void {
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
        targetId: z
          .uuid()
          .optional()
          .describe('Only Jobs that passed the hard filters and prerank of this Target.'),
      },
      outputSchema: { jobs: z.array(jobSchema), nextCursor: z.string().nullable() },
    },
    async ({ limit, cursor, targetId }) => {
      const jobIds = targetId ? await matching.listJobIds(user.id, { targetId }) : undefined;
      const page = await discovery.listJobs(user.id, { limit, cursor, jobIds });
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
    'add_job',
    {
      description:
        'Add a job by hand as a Posting with source manual. It goes through the same dedupe, so a later copy from a board merges with it. Adding the same URL again returns the same Job.',
      inputSchema: {
        title: z.string().min(1),
        company: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
        url: z.url(),
      },
      outputSchema: { jobId: z.string() },
    },
    async (input) => {
      const out = await discovery.addJob(user.id, input);
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'split_job',
    {
      description:
        'Undo a wrong merge: move the given postings (ids from get_job) of a Job into a new Job. Rule and AI merges never put them back. At least one posting must stay in the original Job.',
      inputSchema: { jobId: z.uuid(), postingIds: z.array(z.uuid()).min(1) },
      outputSchema: { jobId: z.string(), splitCount: z.number() },
    },
    async ({ jobId, postingIds }) => {
      try {
        const out = await discovery.splitJob(user.id, jobId, postingIds);
        return { content: [text(out)], structuredContent: out };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'split failed' }],
        };
      }
    },
  );

  mcp.registerTool(
    'list_targets',
    {
      description:
        'List the Targets (named searches) with the criteria set on each and the criteria it ends up using after falling back to the Global defaults.',
      outputSchema: { targets: z.array(targetSchema) },
    },
    async () => {
      const out = { targets: await matching.listTargets(user.id) };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'upsert_target',
    {
      description:
        'Create a Target, or update the one with this name. Only the criteria keys you pass change; null clears a field so it inherits the Global default again. Exclusion words and blocked companies add up with the Global defaults. radiusKm 0 means the same city only; paused stops matching.',
      inputSchema: {
        name: z.string().trim().min(1),
        paused: z.boolean().optional(),
        criteria: criteriaPatchSchema.optional(),
      },
      outputSchema: { target: targetSchema },
    },
    async (input) => {
      try {
        const out = { target: await matching.upsertTarget(user.id, input) };
        return { content: [text(out)], structuredContent: out };
      } catch (err) {
        return failure(err, 'upsert failed');
      }
    },
  );

  mcp.registerTool(
    'get_global_defaults',
    {
      description: 'Get the Global defaults every Target falls back to.',
      outputSchema: { defaults: criteriaSchema },
    },
    async () => {
      const out = { defaults: await matching.getGlobalDefaults(user.id) };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'update_global_defaults',
    {
      description:
        'Change the Global defaults. Only the keys you pass change; null clears a field.',
      inputSchema: { criteria: criteriaPatchSchema },
      outputSchema: { defaults: criteriaSchema },
    },
    async ({ criteria }) => {
      try {
        const out = { defaults: await matching.updateGlobalDefaults(user.id, criteria) };
        return { content: [text(out)], structuredContent: out };
      } catch (err) {
        return failure(err, 'update failed');
      }
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
