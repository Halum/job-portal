import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userSchema, type User } from '@job-portal/accounts';
import { DISCOVERY_STATES, type Discovery } from '@job-portal/discovery';
import { RUN_STATUSES, type Pipeline } from '@job-portal/pipeline';
import { registerBoardTools, type BoardToolDeps } from './board-tools';
import {
  ACTORS,
  APPLICATION_STATUSES,
  STAGES,
  TrackerError,
  type ApplicationTracking,
  type Tracker,
} from '@job-portal/tracker';

export interface ToolDeps {
  discovery: Discovery;
  pipeline: Pipeline;
  boards: BoardToolDeps;
  tracker: Tracker;
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

const trackingSchema = z.object({
  discoveryState: z.enum(DISCOVERY_STATES),
  applicationStatus: z.enum(APPLICATION_STATUSES).nullable(),
  furthestStage: z.enum(STAGES).nullable(),
  appliedOn: z.string().nullable().describe('YYYY-MM-DD in the user timezone'),
  applyBy: z.string().nullable().describe('YYYY-MM-DD in the user timezone'),
});

const dayInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const timelineSchema = z.object({
  id: z.string(),
  field: z.enum(['discovery', 'application']),
  from: z.string().nullable(),
  to: z.string().nullable(),
  actor: z.enum(ACTORS),
  evidence: z.string().nullable(),
  undoes: z.string().nullable(),
  createdAt: isoDate,
});

const noteSchema = z.object({ id: z.string(), text: z.string(), createdAt: isoDate });

const jobSchema = z.object({
  tracking: trackingSchema,
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

const NO_APPLICATION: ApplicationTracking = {
  applicationStatus: null,
  furthestStage: null,
  appliedOn: null,
  applyBy: null,
};

/** A refused change is a tool error with the reason; anything else is a real failure and propagates. */
async function refusable<T>(
  run: () => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; error: { isError: true; content: { type: 'text'; text: string }[] } }
> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof TrackerError) {
      return {
        ok: false,
        error: { isError: true, content: [{ type: 'text', text: err.message }] },
      };
    }
    throw err;
  }
}

export function registerTools(
  mcp: McpServer,
  user: User,
  { discovery, pipeline, tracker, boards }: ToolDeps,
): void {
  registerBoardTools(mcp, user, boards);

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
        'List stored Jobs with their postings and tracking, ordered and paged by Job id. All filters apply before paging, so a page is full whenever enough Jobs match. Pass nextCursor back as cursor for the next page.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.uuid().optional().describe('The nextCursor of the previous page.'),
        discoveryState: z.enum(DISCOVERY_STATES).optional(),
        applicationStatus: z.enum(APPLICATION_STATUSES).optional(),
        discoveredSince: z.iso
          .datetime()
          .optional()
          .describe('Only Jobs first seen at or after this instant.'),
        applyByBefore: dayInput
          .optional()
          .describe('Only Jobs with an apply-by date on or before this day.'),
      },
      outputSchema: { jobs: z.array(jobSchema), nextCursor: z.string().nullable() },
    },
    async ({
      limit,
      cursor,
      discoveryState,
      applicationStatus,
      discoveredSince,
      applyByBefore,
    }) => {
      const filtered = await refusable(async () =>
        applicationStatus || applyByBefore
          ? tracker.findJobIds(user.id, { applicationStatus, applyByOnOrBefore: applyByBefore })
          : null,
      );
      if (!filtered.ok) return filtered.error;
      const page = await discovery.listJobs(user.id, {
        limit,
        cursor,
        discoveryState,
        jobIds: filtered.value,
        discoveredSince: discoveredSince ? new Date(discoveredSince) : undefined,
      });
      const states = await tracker.getStates(
        user.id,
        page.jobs.map((j) => j.id),
      );
      const out = {
        jobs: page.jobs.map((j) => ({
          ...jobOut(j),
          tracking: { discoveryState: j.discoveryState, ...(states.get(j.id) ?? NO_APPLICATION) },
        })),
        nextCursor: page.nextCursor,
      };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'get_job',
    {
      description:
        'Get one Job with all its postings (each as the source gave it), its tracking, its Timeline (oldest first) and its notes.',
      inputSchema: { jobId: z.uuid() },
      outputSchema: {
        job: jobSchema.extend({
          postings: z.array(postingSchema.extend({ raw: z.unknown() })),
          timeline: z.array(timelineSchema),
          notes: z.array(noteSchema),
        }),
      },
    },
    async ({ jobId }) => {
      const job = await discovery.getJob(user.id, jobId);
      if (!job) return { isError: true, content: [{ type: 'text', text: `No Job ${jobId}` }] };
      const [states, { events, notes }] = await Promise.all([
        tracker.getStates(user.id, [jobId]),
        tracker.getTimeline(user.id, jobId),
      ]);
      const out = {
        job: {
          ...job,
          createdAt: job.createdAt.toISOString(),
          postings: job.postings.map(withDates),
          tracking: {
            discoveryState: job.discoveryState,
            ...(states.get(jobId) ?? NO_APPLICATION),
          },
          timeline: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
          notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
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
    'set_status',
    {
      description:
        'Change one thing about a Job: its discovery state (new, shortlisted, dismissed, expired) or its application status (applied, screening, interview, offer, accepted, declined, rejected, withdrawn). Applied takes appliedOn (default today in the user timezone) and an optional applyBy, only from the user or the skill, and a second Applied is refused with the existing date. Final statuses change only through undo_last_change. Set actor to skill when the applying skill makes the change.',
      inputSchema: {
        jobId: z.uuid(),
        actor: z.enum(['user', 'skill']).default('user'),
        discoveryState: z.enum(DISCOVERY_STATES).optional(),
        applicationStatus: z.enum(APPLICATION_STATUSES).optional(),
        appliedOn: dayInput.optional(),
        applyBy: dayInput.optional(),
        evidence: z.string().optional().describe('Why, for the Timeline.'),
      },
      outputSchema: { tracking: trackingSchema },
    },
    async ({ jobId, actor, discoveryState, applicationStatus, appliedOn, applyBy, evidence }) => {
      if ((discoveryState === undefined) === (applicationStatus === undefined)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'give exactly one of discoveryState and applicationStatus',
            },
          ],
        };
      }
      const done = await refusable(() =>
        discoveryState
          ? tracker.setDiscoveryState(user.id, jobId, discoveryState, actor, evidence)
          : tracker.setApplicationStatus(user.id, jobId, {
              to: applicationStatus ?? 'applied',
              actor,
              evidence,
              appliedOn,
              applyBy,
              timezone: user.timezone,
            }),
      );
      if (!done.ok) return done.error;
      const out = { tracking: done.value };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'undo_last_change',
    {
      description:
        'Undo the last state change of a Job (discovery state or application status, including a final one). The undo is itself a Timeline event, and a second undo in a row is refused. Notes are not changes.',
      inputSchema: { jobId: z.uuid(), actor: z.enum(['user', 'skill']).default('user') },
      outputSchema: { tracking: trackingSchema },
    },
    async ({ jobId, actor }) => {
      const done = await refusable(() => tracker.undoLastChange(user.id, jobId, actor));
      if (!done.ok) return done.error;
      const out = { tracking: done.value };
      return { content: [text(out)], structuredContent: out };
    },
  );

  mcp.registerTool(
    'add_note',
    {
      description:
        'Add a free-text note to a Job (who called, what was said). Notes are not state changes.',
      inputSchema: { jobId: z.uuid(), text: z.string().min(1) },
      outputSchema: { note: noteSchema },
    },
    async ({ jobId, text: body }) => {
      if (!(await discovery.getJob(user.id, jobId))) {
        return { isError: true, content: [{ type: 'text' as const, text: `No Job ${jobId}` }] };
      }
      const note = await tracker.addNote(user.id, jobId, body);
      const out = { note: { ...note, createdAt: note.createdAt.toISOString() } };
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
