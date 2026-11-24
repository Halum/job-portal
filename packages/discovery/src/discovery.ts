import { and, asc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm';
import type { Db, DbTx } from '@job-portal/db';
import type { Logger } from '@job-portal/shared';
import type { Source } from './source';
import { companyKey, urlKey } from './keys';
import {
  jobs,
  mergeConflicts,
  neverMerge,
  postings,
  splits,
  type DISCOVERY_STATES,
} from './schema';

export const MANUAL_SOURCE = 'manual';

/** A refusal that is safe to show the caller as it is (bad input, unknown id); anything else is internal. */
export class DiscoveryError extends Error {
  override name = 'DiscoveryError';
}

/** Longest accepted `add_job` fields; the MCP tool schema and its tests use these. */
export const ADD_JOB_LIMITS = { title: 300, company: 200, city: 100, url: 2000 } as const;

export type DiscoveryState = (typeof DISCOVERY_STATES)[number];

export interface PollResult {
  fetched: number;
  newPostings: number;
  errors: string[];
}

export interface PostingView {
  id: string;
  sourceId: string;
  sourcePostingId: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface JobView {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  discoveryState: DiscoveryState;
  createdAt: Date;
  postings: PostingView[];
}

export interface JobDetail extends Omit<JobView, 'postings'> {
  postings: (PostingView & { raw: unknown })[];
}

export interface ListJobsOptions {
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string | null;
  /** Only Jobs created at or after this instant. */
  discoveredSince?: Date;
  /** Only Jobs in this discovery state. */
  discoveryState?: DiscoveryState;
  /** Only these Jobs (another module's filter result); null or undefined means no restriction. */
  jobIds?: string[] | null;
}

export interface Discovery {
  /** Fetches one Source for the user and stores its postings; a Posting seen again is updated. */
  poll: (userId: string, sourceId: string) => Promise<PollResult>;
  /** Jobs ordered and paged by Job id. */
  listJobs: (
    userId: string,
    options: ListJobsOptions,
  ) => Promise<{ jobs: JobView[]; nextCursor: string | null }>;
  getJob: (userId: string, jobId: string) => Promise<JobDetail | null>;
  /** A manual Posting (source `manual`) through the same dedupe; adding the same URL again is a no-op. */
  addJob: (userId: string, input: AddJobInput) => Promise<{ jobId: string }>;
  /**
   * Moves Postings of a Job into a new Job with null keys and records a never-merge pair per Posting.
   * Refuses to empty the Job. `splitCount` is the user's total splits.
   */
  splitJob: (
    userId: string,
    jobId: string,
    postingIds: string[],
  ) => Promise<{ jobId: string; splitCount: number }>;
  /** Postings whose two keys hit different Jobs, kept for the AI merge ticket. */
  listMergeConflicts: (userId: string) => Promise<MergeConflict[]>;
  /**
   * Takes the Job row lock (select for update) inside the caller's transaction; null when the user has no
   * such Job. The Tracker takes it before every Timeline write.
   */
  lockJob: (
    tx: DbTx,
    userId: string,
    jobId: string,
  ) => Promise<{ discoveryState: DiscoveryState } | null>;
  /** Writes the discovery state inside the caller's transaction; the Tracker is its only caller. */
  setDiscoveryState: (
    tx: DbTx,
    userId: string,
    jobId: string,
    state: DiscoveryState,
  ) => Promise<void>;
}

export interface AddJobInput {
  title: string;
  company?: string | null;
  city?: string | null;
  url: string;
}

export interface MergeConflict {
  postingId: string;
  jobIds: string[];
  createdAt: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const jobFields = (j: typeof jobs.$inferSelect): Omit<JobView, 'postings'> => ({
  id: j.id,
  title: j.title,
  company: j.company,
  location: j.location,
  discoveryState: j.discoveryState,
  createdAt: j.createdAt,
});

const postingColumns = {
  id: postings.id,
  sourceId: postings.sourceId,
  sourcePostingId: postings.sourcePostingId,
  title: postings.title,
  company: postings.company,
  location: postings.location,
  url: postings.url,
  postedAt: postings.postedAt,
  firstSeenAt: postings.firstSeenAt,
  lastSeenAt: postings.lastSeenAt,
};

const MAX_ATTEMPTS = 5;

type Tx = DbTx;

interface Incoming {
  sourcePostingId: string;
  title: string;
  company?: string | null;
  location?: string | null;
  url: string;
  postedAt?: Date | null;
  raw: unknown;
}

/**
 * Stores one Posting in its own short transaction (so locks never span a whole poll) and attaches it to
 * a Job. The unique company and URL keys on Jobs are the guard against duplicates: a lost insert race
 * (on conflict do nothing) reselects and attaches to the winner, so concurrent runs cannot both create
 * the Job.
 */
async function ingest(
  db: Db,
  userId: string,
  sourceId: string,
  p: Incoming,
): Promise<{ jobId: string; isNew: boolean }> {
  const values = {
    title: p.title,
    company: p.company ?? null,
    location: p.location ?? null,
    url: p.url,
    postedAt: p.postedAt ?? null,
    raw: p.raw,
  };
  const identity = and(
    eq(postings.userId, userId),
    eq(postings.sourceId, sourceId),
    eq(postings.sourcePostingId, p.sourcePostingId),
  );
  const ck = companyKey(p);
  const uk = urlKey(p.url);

  return db.transaction(async (tx: Tx) => {
    const touch = async (): Promise<string | undefined> =>
      (
        await tx
          .update(postings)
          .set({ ...values, lastSeenAt: sql`now()` })
          .where(identity)
          .returning({ jobId: postings.jobId })
      )[0]?.jobId;

    const seen = await touch();
    if (seen) return { jobId: seen, isNew: false }; // seen before: no new Job

    const keyMatch = or(
      ck ? eq(jobs.companyKey, ck) : undefined,
      uk ? eq(jobs.urlKey, uk) : undefined,
    );
    let jobId: string | undefined;
    let spare = false;
    let conflict: string[] = [];
    for (let attempt = 0; !jobId && attempt < MAX_ATTEMPTS; attempt += 1) {
      const hits = keyMatch
        ? await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.userId, userId), keyMatch))
        : [];
      if (hits.length === 1) {
        jobId = hits[0]?.id; // rule merge (a Dismissed Job takes the Posting too)
      } else if (hits.length > 1) {
        conflict = hits.map((h) => h.id); // keys disagree: merge nothing, record it below
        jobId = await newJob(tx, userId, p, { companyKey: null, urlKey: null });
        spare = true;
      } else {
        const created = await newJob(tx, userId, p, { companyKey: ck, urlKey: uk });
        if (created) {
          jobId = created;
          spare = true;
        } // else a concurrent run inserted a Job with our key first: select it on the next pass
      }
    }
    if (!jobId)
      throw new DiscoveryError('could not place the posting after repeated key conflicts');

    const inserted = await tx
      .insert(postings)
      .values({ userId, sourceId, sourcePostingId: p.sourcePostingId, jobId, ...values })
      .onConflictDoNothing()
      .returning({ id: postings.id });
    const posting = inserted[0];
    if (!posting) {
      // A concurrent run inserted this Posting first: drop our spare Job and update theirs.
      if (spare) await tx.delete(jobs).where(eq(jobs.id, jobId));
      const theirs = await touch();
      if (!theirs) throw new DiscoveryError('posting vanished during insert');
      return { jobId: theirs, isNew: false };
    }
    if (conflict.length > 0) {
      await tx.insert(mergeConflicts).values({ userId, postingId: posting.id, jobIds: conflict });
    }
    return { jobId, isNew: true };
  });
}

async function newJob(
  tx: Tx,
  userId: string,
  p: Incoming,
  keys: { companyKey: string | null; urlKey: string | null },
): Promise<string | undefined> {
  const [job] = await tx
    .insert(jobs)
    .values({ userId, title: p.title, company: p.company, location: p.location, ...keys })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return job?.id;
}

/**
 * ponytail: postings are ingested one by one (one or two queries each); polls hold tens of postings, not
 * thousands. Rule merge only: AI merge arrives with its own ticket.
 */
/** Postgres class 22 (data exception) and 23 (constraint violation) are about the row sent, not the connection. */
function aboutThisPosting(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 4; depth += 1, e = e.cause) {
    if (e instanceof DiscoveryError) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^2[23]\d{3}$/.test(code)) return true;
  }
  return false;
}

export function createDiscovery(db: Db, sources: Source[], logger?: Logger): Discovery {
  const byId = new Map(sources.map((s) => [s.id, s]));

  return {
    async poll(userId, sourceId) {
      const source = byId.get(sourceId);
      if (!source) throw new Error(`unknown source: ${sourceId}`);
      const { postings: fetched, errors } = await source.fetch();
      let newPostings = 0;
      for (const p of fetched) {
        // One Posting the database refuses is an error line; the rest of the poll goes on. Anything
        // else (a lost connection, an unexpected error) fails the run.
        try {
          if ((await ingest(db, userId, sourceId, p)).isNew) newPostings += 1;
        } catch (err) {
          if (!aboutThisPosting(err)) throw err;
          logger?.warn({ err, sourceId, sourcePostingId: p.sourcePostingId }, 'posting not stored');
          errors.push(`posting ${p.sourcePostingId} could not be stored`);
        }
      }
      return { fetched: fetched.length, newPostings, errors };
    },

    async addJob(userId, input) {
      const key = urlKey(input.url);
      if (!key) throw new DiscoveryError('url must be an absolute http or https URL');
      const { jobId } = await ingest(db, userId, MANUAL_SOURCE, {
        sourcePostingId: key,
        title: input.title,
        company: input.company ?? null,
        location: input.city ?? null,
        url: input.url,
        raw: input,
      });
      return { jobId };
    },

    async splitJob(userId, jobId, postingIds) {
      const ids = [...new Set(postingIds)];
      if (ids.length === 0) throw new DiscoveryError('give at least one posting to split off');
      return db.transaction(async (tx: Tx) => {
        // Locking the Job serializes concurrent splits of it.
        const [job] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)))
          .for('update');
        if (!job) throw new DiscoveryError(`No Job ${jobId}`);
        const own = await tx
          .select()
          .from(postings)
          .where(and(eq(postings.userId, userId), eq(postings.jobId, jobId)))
          .orderBy(asc(postings.firstSeenAt));
        const moved = own.filter((o) => ids.includes(o.id));
        if (moved.length !== ids.length) throw new DiscoveryError('not a posting of this job');
        if (moved.length === own.length)
          throw new DiscoveryError('cannot move every posting out of a Job');
        const first = moved[0];
        if (!first) throw new DiscoveryError('nothing to move');

        const [created] = await tx
          .insert(jobs)
          .values({ userId, title: first.title, company: first.company, location: first.location })
          .returning({ id: jobs.id });
        if (!created) throw new Error('job insert returned no row');
        await tx.update(postings).set({ jobId: created.id }).where(inArray(postings.id, ids));
        await tx.insert(neverMerge).values(ids.map((postingId) => ({ userId, postingId, jobId })));
        await tx.insert(splits).values({ userId, fromJobId: jobId, newJobId: created.id });
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(splits)
          .where(eq(splits.userId, userId));
        return { jobId: created.id, splitCount: count?.n ?? 0 };
      });
    },

    async listMergeConflicts(userId) {
      return db
        .select({
          postingId: mergeConflicts.postingId,
          jobIds: mergeConflicts.jobIds,
          createdAt: mergeConflicts.createdAt,
        })
        .from(mergeConflicts)
        .where(eq(mergeConflicts.userId, userId))
        .orderBy(asc(mergeConflicts.createdAt));
    },

    async lockJob(tx, userId, jobId) {
      const [job] = await tx
        .select({ discoveryState: jobs.discoveryState })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)))
        .for('update');
      return job ?? null;
    },

    async setDiscoveryState(tx, userId, jobId, state) {
      await tx
        .update(jobs)
        .set({ discoveryState: state })
        .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)));
    },

    async listJobs(
      userId,
      { limit = DEFAULT_LIMIT, cursor, discoveredSince, discoveryState, jobIds },
    ) {
      if (jobIds && jobIds.length === 0) return { jobs: [], nextCursor: null };
      const size = Math.min(Math.max(limit, 1), MAX_LIMIT);
      const rows = await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.userId, userId),
            cursor ? gt(jobs.id, cursor) : undefined,
            discoveredSince ? gte(jobs.createdAt, discoveredSince) : undefined,
            discoveryState ? eq(jobs.discoveryState, discoveryState) : undefined,
            jobIds ? inArray(jobs.id, jobIds) : undefined,
          ),
        )
        .orderBy(asc(jobs.id))
        .limit(size + 1);
      const page = rows.slice(0, size);
      const ps = page.length
        ? await db
            .select({ jobId: postings.jobId, ...postingColumns })
            .from(postings)
            .where(
              and(
                eq(postings.userId, userId),
                inArray(
                  postings.jobId,
                  page.map((j) => j.id),
                ),
              ),
            )
            .orderBy(asc(postings.firstSeenAt))
        : [];
      return {
        jobs: page.map((j) => ({
          ...jobFields(j),
          postings: ps.filter((p) => p.jobId === j.id).map(({ jobId: _jobId, ...p }) => p),
        })),
        nextCursor: rows.length > size ? (page.at(-1)?.id ?? null) : null,
      };
    },

    async getJob(userId, jobId) {
      const [job] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId)));
      if (!job) return null;
      const ps = await db
        .select({ ...postingColumns, raw: postings.raw })
        .from(postings)
        .where(and(eq(postings.userId, userId), eq(postings.jobId, jobId)))
        .orderBy(asc(postings.firstSeenAt));
      return { ...jobFields(job), postings: ps };
    },
  };
}
