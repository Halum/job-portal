import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import type { AiMerge, Discovery, PostingView } from '@job-portal/discovery';
import { MailMatchError, type Mail, type Notify } from '@job-portal/mail';
import type { Matching } from '@job-portal/matching';
import {
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ReviewError,
  fitRejectionSubject,
  mergeSubject,
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
  /** Applies ai_merge items; without it they are refused as unsupported. */
  aiMerge?: Pick<AiMerge, 'apply'>;
  /** Applies decided mail_match items and shows the mail behind them; without it they cannot be decided. */
  mail?: Pick<Mail, 'getMatch' | 'applyMatch'>;
  /** Sends the Telegram line of a Gmail status change a decision made. */
  notify?: Pick<Notify, 'sendLines'>;
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
  mail: z
    .object({
      from: z.string(),
      subject: z.string(),
      summary: z.string(),
      kind: z
        .string()
        .describe('What the AI read the mail as: rejection, screening, interview or offer.'),
      suggestedJobId: z
        .string()
        .describe('The Job the AI picked; confirming applies the mail to it.'),
      possibleJobIds: z
        .array(z.string())
        .describe('The Jobs the mail could belong to; decide_review may pick any of them.'),
    })
    .nullable()
    .describe('The mail behind a mail_match item; null otherwise.'),
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
  { review, discovery, matching, aiMerge, mail, notify, logger }: ReviewToolDeps,
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
      mail: null,
    };
    const link = ({ id, sourceId, title, company, location, url }: PostingView) => ({
      id,
      sourceId,
      title,
      company,
      location,
      url,
    });
    if (item.kind === 'ai_merge') {
      const pair = mergeSubject.safeParse(item.subject);
      if (!pair.success) return base;
      const both = await Promise.all(
        [pair.data.jobA, pair.data.jobB].map((id) => discovery.getJob(user.id, id)),
      );
      return { ...base, postings: both.flatMap((j) => (j?.postings ?? []).map(link)) };
    }
    if (item.kind === 'mail_match') {
      const match = await mail?.getMatch(user.id, item.subject.messageId ?? '');
      if (!match) return base;
      // The suggested Job first, then the other candidates.
      const ids = [
        match.suggestedJobId,
        ...match.possibleJobIds.filter((id) => id !== match.suggestedJobId),
      ];
      const found = await Promise.all(ids.map((id) => discovery.getJob(user.id, id)));
      return {
        ...base,
        postings: found.flatMap((j) => (j?.postings ?? []).map(link)),
        mail: {
          from: match.from,
          subject: match.subject,
          summary: match.summary,
          kind: match.kind,
          suggestedJobId: match.suggestedJobId,
          possibleJobIds: match.possibleJobIds,
        },
      };
    }
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
      postings: (job?.postings ?? []).map(link),
      target: pair ? { id: pair.targetId, name: pair.targetName } : null,
      score: pair?.score ?? null,
      reasons: pair?.reasons ?? [],
      redFlags: pair?.redFlags ?? [],
    };
  };

  // The module that created an item applies its decision. A kind without an applier is refused.
  // A mail_match decision may produce a Telegram line, collected here and sent after the commit.
  const appliersFor = (
    lines: string[],
    jobId: string | undefined,
  ): Partial<Record<ReviewKind, ReviewApplier>> => ({
    ai_fit_rejection: (item, tx, decision) =>
      matching.applyFitRejection(tx, user.id, item.subject, decision),
    ...(aiMerge
      ? { ai_merge: (item, tx, decision) => aiMerge.apply(tx, user.id, item.subject, decision) }
      : {}),
    ...(mail
      ? {
          mail_match: async (item, tx, decision) => {
            const line = await mail.applyMatch(tx, user.id, item.subject, decision, jobId);
            if (line !== null) lines.push(line);
          },
        }
      : {}),
  });

  mcp.registerTool(
    'list_reviews',
    {
      description:
        'List Review items: questions the system could not settle alone (an AI fit rejection or an AI merge, later unclear mail matches). Pending ones by default; kind and status filter. Each item shows the posting links (the postings of both Jobs for an ai_merge), the Target, the AI score, its reasons and red flags, and the model that made the call. Ordered and paged by id; pass nextCursor back as cursor.',
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
        'Decide a pending Review item. confirm: you agree with the AI (an AI fit rejection stays untagged; an AI merge merges the two Jobs into one with all postings, keeping the one that has an application, else the older; refused with the reason while both have an application, either is dismissed or expired, or a split or earlier disagreement bars the pair). disagree: you do not; for an AI fit rejection the Job is tagged with that Target at once, for an AI merge the two Jobs are never proposed for merging again. An item can be decided once.',
      inputSchema: {
        id: z.uuid(),
        decision: z.enum(['confirm', 'disagree']),
        jobId: z
          .uuid()
          .optional()
          .describe(
            'mail_match, confirm only: apply the mail to this Job, one of the item possibleJobIds, instead of the one the AI picked. A mail_match confirm applies the mail through the Timeline and posts a Telegram line; disagree records only your decision.',
          ),
      },
      outputSchema: { item: itemOut },
    },
    async ({ id, decision, jobId }) => {
      try {
        const lines: string[] = [];
        const appliers = appliersFor(lines, jobId);
        const done = await review.decide(user.id, id, decision, (item, tx, d) => {
          const apply = appliers[item.kind];
          if (!apply) {
            throw new ReviewError(
              'unsupported_kind',
              `Review items of kind ${item.kind} cannot be decided yet`,
            );
          }
          if (jobId !== undefined && item.kind !== 'mail_match') {
            throw new ReviewError('unsupported_kind', 'jobId applies to mail_match items only');
          }
          return apply(item, tx, d);
        });
        if (lines.length > 0) {
          await notify?.sendLines(user.id, lines).catch((err: unknown) => {
            logger.warn({ err }, 'could not send the Gmail status line');
          });
        }
        return ok({ item: await describe(done) });
      } catch (err) {
        if (err instanceof ReviewError || err instanceof MailMatchError)
          return refusal(err.message);
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
