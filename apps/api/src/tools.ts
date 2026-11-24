import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userSchema, type User } from '@job-portal/accounts';
import {
  ADD_JOB_LIMITS,
  DISCOVERY_STATES,
  DiscoveryError,
  type AiMerge,
  type Discovery,
} from '@job-portal/discovery';
import type { AiLog } from '@job-portal/ai';
import { criteriaPatchSchema, criteriaSchema, type Matching } from '@job-portal/matching';
import { RUN_STATUSES, type Pipeline } from '@job-portal/pipeline';
import type { Review } from '@job-portal/review';
import type { Logger } from '@job-portal/shared';
import { registerBoardTools, type BoardToolDeps } from './board-tools';
import { registerReviewTools } from './review-tools';
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
  matching: Matching;
  pipeline: Pipeline;
  /** The AI call log, for the totals in get_run_history. */
  aiLog: Pick<AiLog, 'totals'>;
  boards: BoardToolDeps;
  review: Review;
  /** Applies decided ai_merge items; without it they cannot be decided. */
  aiMerge?: Pick<AiMerge, 'apply'>;
  tracker: Tracker;
  logger: Logger;
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

const scoreSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  prerankScore: z.number(),
  unknownLocation: z
    .boolean()
    .describe('The place could not be resolved, so the radius was not checked.'),
  score: z.number().nullable().describe('AI fit score 0 to 100; null while unscored.'),
  reasons: z.array(z.string()),
  redFlags: z.array(z.string()),
  languages: z
    .array(
      z.object({
        language: z.string(),
        required: z.enum(['none', 'optional', 'required']),
        level: z.string().nullable(),
        phrase: z.string().nullable(),
      }),
    )
    .describe('What the posting demands, as the AI extracted it.'),
  languageMet: z
    .boolean()
    .nullable()
    .describe(
      'Judged in code against the Target language ability; null when the Target sets none.',
    ),
  tagged: z.boolean().describe('Scored at or above the alert threshold.'),
});

const runSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.enum(RUN_STATUSES),
  fetched: z.number(),
  newPostings: z.number(),
  prerankPassed: z.number().describe('Job and Target pairs that passed the filters and prerank'),
  scored: z.number().describe('Job and Target pairs that got an AI fit score in this run'),
  tagged: z.number().describe('Of those, the pairs at or above the alert threshold'),
  aiRejections: z
    .number()
    .describe('Review items raised in this run for scores below the threshold'),
  aiMergeItems: z
    .number()
    .describe(
      'ai_merge Review items raised in this run for pairs of Jobs the AI judged to be one job',
    ),
  aiCalls: z.number().describe('AI calls of this run: fit scores and merge checks'),
  aiCostUsd: z
    .number()
    .nullable()
    .describe('US dollars the runner reported for this run; null when it reported none'),
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

/** A tool error: the message of an expected refusal as it is, a fixed text for anything else (never a raw database error). */
const failure = (
  err: unknown,
  fallback: string,
): { isError: true; content: { type: 'text'; text: string }[] } => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof DiscoveryError ? err.message : fallback }],
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
  { discovery, matching, pipeline, tracker, aiLog, boards, review, aiMerge, logger }: ToolDeps,
): void {
  registerBoardTools(mcp, user, boards, logger);
  registerReviewTools(mcp, user, { review, discovery, matching, aiMerge, logger });

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
        targetId: z
          .uuid()
          .optional()
          .describe('Only Jobs that passed the hard filters and prerank of this Target.'),
        minScore: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe(
            'With targetId: only Jobs whose AI fit score for that Target is at least this. Unscored Jobs never match, not even 0.',
          ),
        tagged: z
          .boolean()
          .optional()
          .describe(
            'With targetId: true keeps Jobs scored at or above the threshold the Target uses now, false keeps Jobs scored below it. Unscored Jobs match neither.',
          ),
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
      targetId,
      minScore,
      tagged,
      discoveryState,
      applicationStatus,
      discoveredSince,
      applyByBefore,
    }) => {
      if ((minScore !== undefined || tagged !== undefined) && targetId === undefined) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'minScore and tagged need targetId: scores are per Target',
            },
          ],
        };
      }
      const filtered = await refusable(async () =>
        applicationStatus || applyByBefore
          ? tracker.findJobIds(user.id, { applicationStatus, applyByOnOrBefore: applyByBefore })
          : null,
      );
      if (!filtered.ok) return filtered.error;
      const byTarget = targetId
        ? new Set(await matching.listJobIds(user.id, { targetId, minScore, tagged }))
        : null;
      const jobIds =
        filtered.value && byTarget
          ? filtered.value.filter((id) => byTarget.has(id))
          : (filtered.value ?? (byTarget ? [...byTarget] : undefined));
      const page = await discovery.listJobs(user.id, {
        limit,
        cursor,
        discoveryState,
        jobIds,
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
        'Get one Job with all its postings (each as the source gave it), its tracking, its Timeline (oldest first), its notes and, for each Target it is a candidate for, its AI fit score, reasons, red flags, language judgement, tag and unknown-location flag.',
      inputSchema: { jobId: z.uuid() },
      outputSchema: {
        job: jobSchema.extend({
          postings: z.array(postingSchema.extend({ raw: z.unknown() })),
          timeline: z.array(timelineSchema),
          notes: z.array(noteSchema),
          scores: z.array(scoreSchema),
        }),
      },
    },
    async ({ jobId }) => {
      const job = await discovery.getJob(user.id, jobId);
      if (!job) return { isError: true, content: [{ type: 'text', text: `No Job ${jobId}` }] };
      const [states, { events, notes }, scores] = await Promise.all([
        tracker.getStates(user.id, [jobId]),
        tracker.getTimeline(user.id, jobId),
        matching.listScores(user.id, jobId),
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
          scores,
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
        title: z.string().min(1).max(ADD_JOB_LIMITS.title),
        company: z.string().min(1).max(ADD_JOB_LIMITS.company).optional(),
        city: z.string().min(1).max(ADD_JOB_LIMITS.city).optional(),
        url: z.url({ protocol: /^https?$/ }).max(ADD_JOB_LIMITS.url),
      },
      outputSchema: { jobId: z.string() },
    },
    async (input) => {
      try {
        const out = await discovery.addJob(user.id, input);
        return { content: [text(out)], structuredContent: out };
      } catch (err) {
        return failure(err, 'add_job failed');
      }
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
        return failure(err, 'split_job failed');
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
        'Create a Target, or update the one with this name. Only the criteria keys you pass change; null clears a field so it inherits the Global default again. Exclusion words and blocked companies add up with the Global defaults. radiusKm 0 means the same city only; paused stops matching. The Target is matched at once over every stored Job and its list_jobs candidates are replaced; a Target with no keywords gets the top N stored Jobs at once (the newest), because nothing scores them. salaryFloor is stored but not enforced yet (no source reports salary). Editing criteria never rescores a Job that already has an AI fit score (that would cost AI calls); only alertThreshold changes what is tagged, because the tag is derived from the score and the threshold when read.',
      inputSchema: {
        name: z.string().trim().min(1).max(100),
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
        'Change the Global defaults. Only the keys you pass change; null clears a field. goneColdDays (integer of at least 1, null disables) is the number of days without a status change after which an application goes Gone cold; it only applies here, not on a Target.',
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
        'List recent Runs, newest first: source, status, counts (fetched, new postings, prerank passed, scored, tagged, AI rejections, AI calls, AI cost in US dollars) and errors, plus aiTotals: every AI call ever logged for the user (calls, failures, tokens, cost where reported).',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      outputSchema: {
        runs: z.array(runSchema),
        aiTotals: z.object({
          calls: z.number(),
          failures: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          costUsd: z.number().describe('Sum of the costs the runners reported.'),
        }),
      },
    },
    async ({ limit }) => {
      const [runs, aiTotals] = await Promise.all([
        pipeline.listRuns(user.id, limit ?? 20),
        aiLog.totals(user.id),
      ]);
      const out = {
        aiTotals,
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
