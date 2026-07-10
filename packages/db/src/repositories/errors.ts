import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ErrorStage } from '@job-portal/shared';
import type { Database } from '../client.js';
import { errors } from '../schema/errors.js';

export type ErrorRow = InferSelectModel<typeof errors>;

export interface InsertErrorInput {
  source: string | null;
  jobId: number | null;
  stage: ErrorStage;
  attempts: number;
  errorMessage: string;
  errorStack?: string | null;
  payload?: unknown;
}

/** Writes one failure row (PRD §13 step 2). Returns the new id so the caller
 * can flip `webhook_delivered` once the notification lands. */
export async function insertError(db: Database, input: InsertErrorInput): Promise<number> {
  const [row] = await db
    .insert(errors)
    .values({
      source: input.source,
      jobId: input.jobId,
      stage: input.stage,
      attempts: input.attempts,
      errorMessage: input.errorMessage,
      errorStack: input.errorStack ?? null,
      payload: input.payload ?? null,
    })
    .returning({ id: errors.id });
  return row!.id;
}

/** Flips the terminal webhook-delivery flag (PRD §13 step 4). */
export async function markWebhookDelivered(
  db: Database,
  id: number,
  delivered: boolean,
): Promise<void> {
  await db.update(errors).set({ webhookDelivered: delivered }).where(eq(errors.id, id));
}

export interface ListErrorsWindow {
  stage?: ErrorStage;
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

/**
 * Window pagination over the errors audit table (PRD §12), same contract as
 * `listJobsWindow` but keyed on `created_at`. Stable `created_at ASC, id ASC`
 * sort keeps offset pagination deterministic.
 */
export async function listErrorsWindow(db: Database, w: ListErrorsWindow): Promise<ErrorRow[]> {
  const conditions = [gte(errors.createdAt, w.from), lt(errors.createdAt, w.to)];
  if (w.stage !== undefined) conditions.push(eq(errors.stage, w.stage));

  return db
    .select()
    .from(errors)
    .where(and(...conditions))
    .orderBy(asc(errors.createdAt), asc(errors.id))
    .limit(w.limit)
    .offset(w.offset);
}
