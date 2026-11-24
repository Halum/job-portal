import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Discovery } from '@job-portal/discovery';
import { runs, type RunStatus } from './schema';

export interface Run {
  id: string;
  sourceId: string;
  status: RunStatus;
  fetched: number;
  newPostings: number;
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
  /** Marks every run left "running" as failed; call once on worker start. Returns how many. */
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
  errors: runs.errors,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

/**
 * ponytail: the only stage is Discovery (fetch and store). Matching, Review and Notifications
 * join the run in later tickets. failStaleRuns assumes one worker process; with several, it would
 * fail another worker's live run.
 */
export function createPipeline(db: Db, discovery: Pick<Discovery, 'poll'>): Pipeline {
  return {
    async execute(userId, sourceId) {
      const [started] = await db
        .insert(runs)
        .values({ userId, sourceId, status: 'running' })
        .onConflictDoNothing()
        .returning({ id: runs.id });
      if (!started) return null;

      const finish = async (
        values: Pick<Run, 'status' | 'fetched' | 'newPostings' | 'errors'>,
      ): Promise<Run> => {
        const [run] = await db
          .update(runs)
          .set({ ...values, finishedAt: sql`now()` })
          .where(eq(runs.id, started.id))
          .returning(columns);
        if (!run) throw new Error('run vanished');
        return run;
      };

      try {
        const { fetched, newPostings, errors } = await discovery.poll(userId, sourceId);
        return await finish({
          status: errors.length > 0 ? 'completed_with_errors' : 'completed',
          fetched,
          newPostings,
          errors,
        });
      } catch (err) {
        return finish({
          status: 'failed',
          fetched: 0,
          newPostings: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    },

    async failStaleRuns() {
      const failed = await db
        .update(runs)
        .set({
          status: 'failed',
          errors: ['worker stopped during the run'],
          finishedAt: sql`now()`,
        })
        .where(eq(runs.status, 'running'))
        .returning({ id: runs.id });
      return failed.length;
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
