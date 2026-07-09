import { and, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { PromptRole, SourceType } from '@job-portal/shared';
import type { Database } from '../client.js';
import { prompts } from '../schema/prompts.js';

export type Prompt = InferSelectModel<typeof prompts>;

/** The single prompt row for (source, role), or null if none. */
export async function getPrompt(
  db: Database,
  source: SourceType,
  role: PromptRole,
): Promise<Prompt | null> {
  const rows = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.source, source), eq(prompts.role, role)))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertPromptInput {
  source: SourceType;
  role: PromptRole;
  template: string;
}

/**
 * Destructive upsert (PRD S2a rework): INSERT ... ON CONFLICT (source, role)
 * DO UPDATE SET template, updated_at. Exactly one row per (source, role) —
 * editing overwrites in place. Returns the resulting row.
 */
export async function upsertPrompt(db: Database, input: UpsertPromptInput): Promise<Prompt> {
  const { source, role, template } = input;
  const [row] = await db
    .insert(prompts)
    .values({ source, role, template })
    .onConflictDoUpdate({
      target: [prompts.source, prompts.role],
      set: { template, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}
