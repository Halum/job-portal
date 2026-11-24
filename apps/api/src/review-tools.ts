import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import type { Discovery } from '@job-portal/discovery';
import type { Matching } from '@job-portal/matching';
import {
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ReviewError,
  fitRejectionSubject,
  type Review,
  type ReviewApplier,
  type ReviewItem,
  type ReviewKind,
} from '@job-portal/review';
import type { Logger } from '@job-portal/shared';

export interface ReviewToolDeps {
  review: Review;
  discovery: Pick<Discovery, 'getJob'>;
  matching: Pick<Matching, 'listScores' | 'applyFitRejection'>;
  logger: Logger;
}

const postingOut = z.object({
  id: z.string(),
  sourceId: z.string(),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string(),
});

const itemOut = z.object({
  id: z.string(),
  kind: z.enum(REVIEW_KINDS),
  status: z.enum(REVIEW_STATUSES),
  model: z.string().describe('The model that made the AI call this item questions.'),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  subject: z.record(z.string(), z.string()),
  postings: z.array(postingOut).describe('Links to check before deciding.'),
  target: z.object({ id: z.string(), name: z.string() }).nullable(),
  score: z.number().nullable().describe('AI fit score of an ai_fit_rejection; null otherwise.'),
  reasons: z.array(z.string()),
  redFlags: z.array(z.string()),
});

const ok = (out: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(out) }],
  structuredContent: out,
});
const refusal = (message: string) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: message }],
});

export function registerReviewTools(
  mcp: McpServer,
  user: User,
  { review, discovery, matching, logger }: ReviewToolDeps,
): void {
  /** Posting links, Target and score of an item, read from the modules that own them. */
  const describe = async (item: ReviewItem): Promise<z.infer<typeof itemOut>> => {
    const base = {
      id: item.id,
      kind: item.kind,
      status: item.status,
      model: item.model,
      createdAt: item.createdAt.toISOString(),
      decidedAt: item.decidedAt ? item.decidedAt.toISOString() : null,
      subject: item.subject,
      postings: [],
      target: null,
      score: null,
      reasons: [],
      redFlags: [],
    };
    // ponytail: only ai_fit_rejection has details so far; ai_merge and mail_match add theirs with their tickets.
    if (item.kind !== 'ai_fit_rejection') return base;
    const subject = fitRejectionSubject.safeParse(item.subject);
    if (!subject.success) return base;
    const { jobId, targetId } = subject.data;
    const [job, scores] = await Promise.all([
      discovery.getJob(user.id, jobId),
      matching.listScores(user.id, jobId),
    ]);
    // The pair has no entry once an edit of the Target dropped the Job from its candidates; the links stay.
    const pair = scores.find((s) => s.targetId === targetId);
    return {
      ...base,
      postings: (job?.postings ?? []).map(({ id, sourceId, title, company, location, url }) => ({
        id,
        sourceId,
        title,
        company,
        location,
        url,
      })),
      target: pair ? { id: pair.targetId, name: pair.targetName } : null,
      score: pair?.score ?? null,
      reasons: pair?.reasons ?? [],
      redFlags: pair?.redFlags ?? [],
    };
  };

  // The module that created an item applies its decision. A kind without an applier is refused.
  const appliers: Partial<Record<ReviewKind, ReviewApplier>> = {
    ai_fit_rejection: (item, tx, decision) =>
      matching.applyFitRejection(tx, user.id, item.subject, decision),
  };

  mcp.registerTool(
    'list_reviews',
    {
      description:
        'List Review items: questions the system could not settle alone (an AI fit rejection, later AI merges and unclear mail matches). Pending ones by default; kind and status filter. Each item shows the posting links, the Target, the AI score, its reasons and red flags, and the model that made the call. Ordered and paged by id; pass nextCursor back as cursor.',
      inputSchema: {
        kind: z.enum(REVIEW_KINDS).optional(),
        status: z.enum(REVIEW_STATUSES).optional().describe('Default pending.'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.uuid().optional().describe('The nextCursor of the previous page.'),
      },
      outputSchema: { items: z.array(itemOut), nextCursor: z.string().nullable() },
    },
    async ({ kind, status, limit, cursor }) => {
      const page = await review.list(user.id, { kind, status, limit, cursor });
      return ok({
        items: await Promise.all(page.items.map(describe)),
        nextCursor: page.nextCursor,
      });
    },
  );

  mcp.registerTool(
    'decide_review',
    {
      description:
        'Decide a pending Review item. confirm: you agree with the AI (an AI fit rejection stays untagged). disagree: you do not; for an AI fit rejection the Job is tagged with that Target at once. An item can be decided once.',
      inputSchema: { id: z.uuid(), decision: z.enum(['confirm', 'disagree']) },
      outputSchema: { item: itemOut },
    },
    async ({ id, decision }) => {
      try {
        const done = await review.decide(user.id, id, decision, (item, tx, d) => {
          const apply = appliers[item.kind];
          if (!apply) {
            throw new ReviewError(
              'unsupported_kind',
              `Review items of kind ${item.kind} cannot be decided yet`,
            );
          }
          return apply(item, tx, d);
        });
        return ok({ item: await describe(done) });
      } catch (err) {
        if (err instanceof ReviewError) return refusal(err.message);
        logger.error({ err }, 'decide_review failed');
        return refusal('decide_review failed');
      }
    },
  );

  mcp.registerTool(
    'review_stats',
    {
      description:
        'How often you agreed with the AI: counts of confirmed (agreed) and disagreed Review items per kind and model, the number still pending, and the items where you agreed ("survived").',
      outputSchema: {
        pending: z.number(),
        counts: z.array(
          z.object({
            kind: z.enum(REVIEW_KINDS),
            model: z.string(),
            agreed: z.number(),
            disagreed: z.number(),
          }),
        ),
        survived: z.array(itemOut),
      },
    },
    async () => {
      const [stats, pending] = await Promise.all([
        review.stats(user.id),
        review.countPending(user.id),
      ]);
      return ok({
        pending,
        counts: stats.counts,
        survived: await Promise.all(stats.survived.map(describe)),
      });
    },
  );
}
