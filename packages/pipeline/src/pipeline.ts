import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Discovery } from '@job-portal/discovery';
import { emptyScoreResult, type Matching } from '@job-portal/matching';
import { runs, type RunStatus } from './schema';

export interface Run {
  id: string;
  sourceId: string;
  status: RunStatus;
  fetched: number;
  newPostings: number;
  prerankPassed: number;
  scored: number;
  tagged: number;
  aiCalls: number;
  /** null when no call reported a cost. */
  aiCostUsd: number | null;
  errors: string[];
  startedAt: Date;
  finishedAt: Date | null;
}

export interface Pipeline {
  /**
   * Runs one source once and records the Run. Returns null, without polling, when a run for this
   * user and source is already active.
   */
  execute: (userId: string, sourceId: string) => Promise<Run | null>;
  /**
   * Fails runs left "running" for longer than the time bound; call on worker start. A fresh run,
   * which may belong to another live worker, is left alone. Returns how many.
   */
  failStaleRuns: () => Promise<number>;
  /** The user's Runs, newest first. */
  listRuns: (userId: string, limit: number) => Promise<Run[]>;
}

const columns = {
  id: runs.id,
  sourceId: runs.sourceId,
  status: runs.status,
  fetched: runs.fetched,
  newPostings: runs.newPostings,
  prerankPassed: runs.prerankPassed,
  scored: runs.scored,
  tagged: runs.tagged,
  aiCalls: runs.aiCalls,
  aiCostUsd: runs.aiCostUsd,
  errors: runs.errors,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

export interface PipelineOptions {
  /**
   * A run still "running" after this long is treated as lost (its worker died or its status write
   * failed) and is failed by the next execute for the same source. Default one hour.
   */
  staleAfterMs?: number;
  /** Runs after each poll over the Jobs it created; a failure there is an error line, not a failed run. */
  matching?: Pick<Matching, 'run'>;
  /**
   * Runs after Matching, over every unscored candidate of the user, not only this run's Jobs, so a pair
   * whose AI call failed is retried by the next run of any source. A failed call is an error line.
   */
  scoring?: Pick<Matching, 'score'>;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * ponytail: the only stage is Discovery (fetch and store). Matching, Review and Notifications
 * join the run in later tickets. Any number of workers may share one database: the unique index
 * allows one running run per source, and only runs older than the time bound are ever failed as lost.
 */
export function createPipeline(
  db: Db,
  discovery: Pick<Discovery, 'poll'>,
  { staleAfterMs = DEFAULT_STALE_AFTER_MS, matching, scoring }: PipelineOptions = {},
): Pipeline {
  /** Fails runs still "running" past the time bound that also match `scope`; returns how many. */
  const failLost = async (...scope: (SQL | undefined)[]): Promise<number> => {
    const failed = await db
      .update(runs)
      .set({
        status: 'failed',
        errors: ['run did not finish within the time bound'],
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(runs.status, 'running'),
          lt(runs.startedAt, sql`now() - ${staleAfterMs} * interval '1 millisecond'`),
          ...scope,
        ),
      )
      .returning({ id: runs.id });
    return failed.length;
  };

  return {
    async execute(userId, sourceId) {
      // A lost run would otherwise hold the one-active-run index until the next worker start.
      await failLost(eq(runs.userId, userId), eq(runs.sourceId, sourceId));
      const [started] = await db
        .insert(runs)
        .values({ userId, sourceId, status: 'running' })
        .onConflictDoNothing()
        .returning({ id: runs.id });
      if (!started) return null;

      const finish = async (
        values: Pick<
          Run,
          | 'status'
          | 'fetched'
          | 'newPostings'
          | 'prerankPassed'
          | 'scored'
          | 'tagged'
          | 'aiCalls'
          | 'aiCostUsd'
          | 'errors'
        >,
      ): Promise<Run> => {
        // Only a run still "running" may finish: one failed as lost keeps its failed row.
        const [run] = await db
          .update(runs)
          .set({ ...values, finishedAt: sql`now()` })
          .where(and(eq(runs.id, started.id), eq(runs.status, 'running')))
          .returning(columns);
        if (run) return run;
        const [current] = await db.select(columns).from(runs).where(eq(runs.id, started.id));
        if (!current) throw new Error('run vanished');
        return current;
      };

      try {
        const { fetched, newPostings, jobIds, errors } = await discovery.poll(userId, sourceId);
        let prerankPassed = 0;
        if (matching) {
          try {
            prerankPassed = (await matching.run(userId, jobIds)).prerankPassed;
          } catch (err) {
            errors.push(`matching failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        let ai = emptyScoreResult();
        if (scoring) {
          try {
            ai = await scoring.score(userId);
            errors.push(...ai.errors);
          } catch (err) {
            errors.push(`scoring failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return await finish({
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          fetched,
          newPostings,
          prerankPassed,
          scored: ai.scored,
          tagged: ai.tagged,
          aiCalls: ai.calls,
          aiCostUsd: ai.costUsd,
          errors,
        });
      } catch (err) {
        return finish({
          status: 'failed',
          fetched: 0,
          newPostings: 0,
          prerankPassed: 0,
          scored: 0,
          tagged: 0,
          aiCalls: 0,
          aiCostUsd: null,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    },

    failStaleRuns() {
      return failLost();
    },

    listRuns(userId, limit) {
      return db
        .select(columns)
        .from(runs)
        .where(eq(runs.userId, userId))
        .orderBy(desc(runs.startedAt))
        .limit(limit);
    },
  };
}
