import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { AiError, type AiResult, type AiRunner } from './runner';
import { calls } from './schema';

export interface AiTotals {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the costs the runners reported; calls that reported none add nothing. */
  costUsd: number;
}

export interface CallRecord {
  runner: string;
  model: string | null;
  feature: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number;
  outcome: 'ok' | 'error';
  errorClass: string | null;
  createdAt: Date;
}

export interface AiLog {
  record: (userId: string, call: Omit<CallRecord, 'createdAt'>) => Promise<void>;
  totals: (userId: string) => Promise<AiTotals>;
  /** The user's latest calls, newest first. */
  recent: (userId: string, limit: number) => Promise<CallRecord[]>;
}

export function createAiLog(db: Db): AiLog {
  return {
    async record(userId, call) {
      await db.insert(calls).values({ userId, ...call });
    },
    async totals(userId) {
      const [row] = await db
        .select({
          calls: sql<number>`count(*)::int`,
          failures: sql<number>`(count(*) filter (where ${calls.outcome} = 'error'))::int`,
          inputTokens: sql<number>`coalesce(sum(${calls.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${calls.outputTokens}), 0)::int`,
          costUsd: sql<number>`coalesce(sum(${calls.costUsd}), 0)::float8`,
        })
        .from(calls)
        .where(eq(calls.userId, userId));
      if (!row) throw new Error('totals returned no row');
      return row;
    },
    async recent(userId, limit) {
      return db
        .select({
          runner: calls.runner,
          model: calls.model,
          feature: calls.feature,
          inputTokens: calls.inputTokens,
          outputTokens: calls.outputTokens,
          costUsd: calls.costUsd,
          durationMs: calls.durationMs,
          outcome: calls.outcome,
          errorClass: calls.errorClass,
          createdAt: calls.createdAt,
        })
        .from(calls)
        .where(eq(calls.userId, userId))
        .orderBy(desc(calls.createdAt), desc(calls.id))
        .limit(limit);
    },
  };
}

export interface AiOutput<T> {
  value: T;
  /** The model that answered, as the runner reports it. */
  model: string;
  /** What the call cost where the runner reports it; null when unknown. */
  costUsd: number | null;
}

export interface Ai {
  /**
   * One logged AI call: sends the prompt, parses the answer with `parse` (which throws on a bad one)
   * and records the call. Throws an AiError, after logging it, when the call or the parse fails.
   */
  run: <T>(
    userId: string,
    feature: string,
    prompt: string,
    parse: (text: string) => T,
  ) => Promise<AiOutput<T>>;
}

export function createAi(log: AiLog, runner: AiRunner): Ai {
  return {
    async run(userId, feature, prompt, parse) {
      const started = Date.now();
      const base = { runner: runner.name, feature };
      let result: AiResult;
      try {
        result = await runner.complete(prompt);
      } catch (err) {
        const error =
          err instanceof AiError ? err : new AiError('request', 'unexpected runner failure');
        await log.record(userId, {
          ...base,
          model: runner.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          durationMs: Date.now() - started,
          outcome: 'error',
          errorClass: error.errorClass,
        });
        throw error;
      }
      const usage = {
        ...base,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
      };
      let value: ReturnType<typeof parse>;
      try {
        value = parse(result.text);
      } catch {
        // The call was paid for even though its answer is no use: keep its tokens and cost.
        await log.record(userId, { ...usage, outcome: 'error', errorClass: 'bad_output' });
        throw new AiError('bad_output', 'the answer did not match the expected shape');
      }
      await log.record(userId, { ...usage, outcome: 'ok', errorClass: null });
      return { value, model: result.model, costUsd: result.costUsd };
    },
  };
}
