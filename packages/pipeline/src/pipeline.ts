import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { emptyAiMergeResult, type AiMerge, type Discovery } from '@job-portal/discovery';
import { emptyScoreResult, type Matching } from '@job-portal/matching';
import type { Notifications } from '@job-portal/notifications';
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
  /** Review items raised in this run for scores below the threshold. */
  aiRejections: number;
  /** ai_merge Review items raised in this run for pairs of Jobs the AI judged to be one job. */
  aiMergeItems: number;
  /** AI calls of this run: scoring and merge checks together. */
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
  aiRejections: runs.aiRejections,
  aiMergeItems: runs.aiMergeItems,
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
   * Runs after Matching: asks the AI about near-duplicate Jobs and raises ai_merge Review items (nothing
   * merges until the user confirms). Covers every Job of the user, so a pair whose call failed is asked
   * again by the next run of any source. A failure is an error line, not a failed run.
   */
  aiMerge?: Pick<AiMerge, 'run'>;
  /**
   * Runs after Matching, over every unscored candidate of the user, not only this run's Jobs, so a pair
   * whose AI call failed is retried by the next run of any source. A failed call is an error line.
   */
  scoring?: Pick<Matching, 'score'>;
  /**
   * Runs last, after scoring: sends the digest and the failure alerts. A crash there is an error line, never
   * a failed run (a webhook that is down is not a crash: Notifications keeps the messages).
   */
  notifications?: Pick<Notifications, 'afterRun'>;
  /** Names the AI runner in failure types (`ai:<runner>:<class>`). Default "ai". */
  aiRunnerName?: string;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

const BOARD_LINE = /^(\S+) board (.+?): /;
const AI_LINE = /^fit score failed \((\w+)\) for /;

/**
 * The failure types one finished run shows, from the stable error lines Discovery (a failing board) and
 * Matching (a failed AI call with its class) write. A run sees only its own source's boards, and the AI
 * types only when it made calls; whatever it could not see stays as it was.
 */
function observeFailures(
  sourceId: string,
  errors: string[],
  aiCalls: number,
  runner: string,
): { failing: string[]; checked: string[] } {
  const failing = new Set<string>();
  for (const line of errors) {
    const board = BOARD_LINE.exec(line);
    if (board?.[1] === sourceId) failing.add(`board:${sourceId}:${board[2] ?? ''}`);
    const ai = AI_LINE.exec(line);
    if (ai) failing.add(`ai:${runner}:${ai[1] ?? ''}`);
  }
  return {
    failing: [...failing],
    checked: [`source:${sourceId}`, `board:${sourceId}:`, ...(aiCalls > 0 ? ['ai:'] : [])],
  };
}

/**
 * ponytail: stages are Discovery (fetch and store), Matching, scoring and Notifications; Review is
 * not a stage (Matching raises its items). Any number of workers may share one database: the unique index
 * allows one running run per source, and only runs older than the time bound are ever failed as lost.
 */
export function createPipeline(
  db: Db,
  discovery: Pick<Discovery, 'poll'>,
  {
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    matching,
    aiMerge,
    scoring,
    notifications,
    aiRunnerName = 'ai',
  }: PipelineOptions = {},
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
        .returning({ id: runs.id, startedAt: runs.startedAt });
      if (!started) return null;

      /** Never throws: a failed Notifications step is returned as an error line. */
      const notify = async (failing: string[], checked: string[]): Promise<string[]> => {
        if (!notifications) return [];
        try {
          await notifications.afterRun(userId, { since: started.startedAt, failing, checked });
          return [];
        } catch (err) {
          return [`notifications failed: ${err instanceof Error ? err.message : String(err)}`];
        }
      };

      const finish = async (
        values: Pick<
          Run,
          | 'status'
          | 'fetched'
          | 'newPostings'
          | 'prerankPassed'
          | 'scored'
          | 'tagged'
          | 'aiRejections'
          | 'aiMergeItems'
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
        let merge = emptyAiMergeResult();
        if (aiMerge) {
          try {
            merge = await aiMerge.run(userId);
            errors.push(...merge.errors);
          } catch (err) {
            errors.push(`AI merge failed: ${err instanceof Error ? err.message : String(err)}`);
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
        const seen = observeFailures(sourceId, errors, ai.calls, aiRunnerName);
        errors.push(...(await notify(seen.failing, seen.checked)));
        return await finish({
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          fetched,
          newPostings,
          prerankPassed,
          scored: ai.scored,
          tagged: ai.tagged,
          aiRejections: ai.rejections,
          aiMergeItems: merge.items,
          aiCalls: ai.calls + merge.calls,
          // null stays null (unknown) until some call reported a cost; 0 is a real cost.
          aiCostUsd:
            ai.costUsd === null && merge.costUsd === null
              ? null
              : (ai.costUsd ?? 0) + (merge.costUsd ?? 0),
          errors,
        });
      } catch (err) {
        const key = `source:${sourceId}`;
        const message = err instanceof Error ? err.message : String(err);
        return finish({
          status: 'failed',
          fetched: 0,
          newPostings: 0,
          prerankPassed: 0,
          scored: 0,
          tagged: 0,
          aiRejections: 0,
          aiMergeItems: 0,
          aiCalls: 0,
          aiCostUsd: null,
          errors: [message, ...(await notify([key], [key]))],
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
