import { z } from 'zod';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { items, type ReviewKind, type ReviewStatus, type ReviewSubject } from './schema';

export {
  REVIEW_KINDS,
  REVIEW_STATUSES,
  type ReviewKind,
  type ReviewStatus,
  type ReviewSubject,
} from './schema';

/** The subject of an ai_fit_rejection item: the Job and the Target it was scored against. */
export const fitRejectionSubject = z.object({ jobId: z.uuid(), targetId: z.uuid() });

export type ReviewDecision = 'confirm' | 'disagree';

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  subject: ReviewSubject;
  model: string;
  status: ReviewStatus;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface NewReviewItem {
  kind: ReviewKind;
  subject: ReviewSubject;
  model: string;
}

/** What an applier may use: the transaction that records the decision. */
export type ReviewTx = Pick<Db, 'insert' | 'select' | 'update' | 'delete'>;

/** Applies a decision in the module that created the item; it runs inside the decision's transaction. */
export type ReviewApplier = (
  item: ReviewItem,
  tx: ReviewTx,
  decision: ReviewDecision,
) => Promise<void>;

export interface KindModelCount {
  kind: ReviewKind;
  model: string;
  /** Items the user confirmed (agreed with the AI). */
  agreed: number;
  /** Items the user disagreed with. */
  disagreed: number;
}

export class ReviewError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_decided' | 'unsupported_kind',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ListFilter {
  /** Default pending. */
  status?: ReviewStatus;
  kind?: ReviewKind;
  limit?: number;
  /** The nextCursor of the previous page. */
  cursor?: string;
}

/**
 * Review stores items and decisions and counts agreement. It never writes another module's schema and
 * imports no other domain module: the module that created an item applies its decision.
 */
export interface Review {
  /**
   * Raises an item unless the user already has one for this kind and subject (created: false then).
   * Pass the creator's transaction to make the item and the creator's own write one unit.
   */
  create: (
    userId: string,
    input: NewReviewItem,
    tx?: Pick<Db, 'insert'>,
  ) => Promise<{ id: string; created: boolean }>;
  /** The user's items ordered and paged by id. */
  list: (
    userId: string,
    filter: ListFilter,
  ) => Promise<{ items: ReviewItem[]; nextCursor: string | null }>;
  /**
   * Records the decision and runs `apply` in one transaction under the item's row lock: a crash or a
   * failing applier leaves the item pending, and two decisions of one item cannot both apply.
   * Throws ReviewError when the item is not the user's or already decided.
   */
  decide: (
    userId: string,
    id: string,
    decision: ReviewDecision,
    apply: ReviewApplier,
  ) => Promise<ReviewItem>;
  /** Agreement counts per kind and model over decided items, and the confirmed items ("survived"). */
  stats: (userId: string) => Promise<{ counts: KindModelCount[]; survived: ReviewItem[] }>;
  countPending: (userId: string) => Promise<number>;
}

const DEFAULT_LIMIT = 50;

const toItem = (row: typeof items.$inferSelect): ReviewItem => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  model: row.model,
  status: row.status,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
});

export function createReview(db: Db): Review {
  return {
    async create(userId, { kind, subject, model }, tx = db) {
      const [row] = await tx
        .insert(items)
        .values({ userId, kind, subject, model })
        .onConflictDoNothing()
        .returning({ id: items.id });
      if (row) return { id: row.id, created: true };
      const [existing] = await db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.userId, userId), eq(items.kind, kind), eq(items.subject, subject)));
      if (!existing) throw new Error('review item vanished during create');
      return { id: existing.id, created: false };
    },

    async list(userId, { status = 'pending', kind, limit = DEFAULT_LIMIT, cursor }) {
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            eq(items.userId, userId),
            eq(items.status, status),
            kind === undefined ? undefined : eq(items.kind, kind),
            cursor === undefined ? undefined : gt(items.id, cursor),
          ),
        )
        .orderBy(asc(items.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toItem),
        nextCursor: rows.length > limit && last ? last.id : null,
      };
    },

    decide(userId, id, decision, apply) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(items)
          .where(and(eq(items.id, id), eq(items.userId, userId)))
          .for('update');
        if (!row) throw new ReviewError('not_found', `No Review item ${id}`);
        if (row.status !== 'pending') {
          throw new ReviewError('already_decided', `Review item ${id} is already decided`);
        }
        await apply(toItem(row), tx, decision);
        const [saved] = await tx
          .update(items)
          .set({
            status: decision === 'confirm' ? 'confirmed' : 'disagreed',
            decidedAt: new Date(),
          })
          .where(eq(items.id, id))
          .returning();
        if (!saved) throw new Error('review update returned no row');
        return toItem(saved);
      });
    },

    async stats(userId) {
      const counts = await db
        .select({
          kind: items.kind,
          model: items.model,
          agreed: sql<number>`(count(*) filter (where ${items.status} = 'confirmed'))::int`,
          disagreed: sql<number>`(count(*) filter (where ${items.status} = 'disagreed'))::int`,
        })
        .from(items)
        .where(and(eq(items.userId, userId), sql`${items.status} <> 'pending'`))
        .groupBy(items.kind, items.model)
        .orderBy(asc(items.kind), asc(items.model));
      const survived = await db
        .select()
        .from(items)
        .where(and(eq(items.userId, userId), eq(items.status, 'confirmed')))
        .orderBy(asc(items.decidedAt), asc(items.id));
      return { counts, survived: survived.map(toItem) };
    },

    async countPending(userId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(items)
        .where(and(eq(items.userId, userId), eq(items.status, 'pending')));
      return row?.n ?? 0;
    },
  };
}
