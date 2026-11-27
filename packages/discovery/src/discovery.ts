import { and, asc, eq, gt, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db, DbTx } from '@job-portal/db';
import type { Logger } from '@job-portal/shared';
import type { Source } from './source';
import { companyKey, urlKey } from './keys';
import { siteJobId } from './site-job';
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
  /** The Jobs of the Postings stored for the first time in this poll (a merge target counts once). */
  jobIds: string[];
  errors: string[];
}

/** A Job in the shape Matching reads: the Source's own payload comes from its oldest Posting. */
export interface MatchableJobRow {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  raw: unknown;
  recency: Date;
}

export interface PostingView {
  id: string;
  sourceId: string;
  sourcePostingId: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  publisher: string | null;
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
  /** Only the Job with a Posting on this link's URL key (LinkedIn and Indeed links by site job id). */
  url?: string;
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
  /**
   * The Jobs among `ids` (all of the user's when not given) that Matching may look at: New or
   * Shortlisted ones, never Dismissed or Expired.
   */
  listMatchable: (userId: string, ids?: string[]) => Promise<MatchableJobRow[]>;
  /**
   * A hand-added Posting (source `manual`, `linkedin` or `indeed`) through the same dedupe; adding the same
   * job again is a no-op. `created` is true only when this call made the Job; `seenBefore` lists the Job's
   * other Postings, earliest first.
   */
  addJob: (userId: string, input: AddJobInput) => Promise<AddJobResult>;
  /**
   * Moves Postings of a Job into a new Job with null keys and records a never-merge pair per Posting.
   * Refuses to empty the Job. `splitCount` is the user's total splits.
   */
  splitJob: (
    userId: string,
    jobId: string,
    postingIds: string[],
  ) => Promise<{ jobId: string; splitCount: number }>;
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

export const ADD_JOB_SOURCES = ['manual', 'linkedin', 'indeed'] as const;

export type AddJobSource = (typeof ADD_JOB_SOURCES)[number];

export interface AddJobInput {
  title: string;
  company?: string | null;
  city?: string | null;
  url: string;
  /** Where the job was found; default manual. linkedin and indeed need a job link of that site. */
  source?: AddJobSource;
}

export interface SeenBefore {
  sourceId: string;
  publisher: string | null;
  firstSeenAt: Date;
}

export interface AddJobResult {
  jobId: string;
  created: boolean;
  seenBefore: SeenBefore[];
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
  publisher: postings.publisher,
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
  publisher?: string | null;
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
): Promise<{ jobId: string; isNew: boolean; jobCreated: boolean }> {
  const values = {
    title: p.title,
    company: p.company ?? null,
    location: p.location ?? null,
    url: p.url,
    publisher: p.publisher ?? null,
    urlKey: urlKey(p.url),
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
    if (seen) return { jobId: seen, isNew: false, jobCreated: false }; // seen before: no new Job

    const keyMatch = or(
      ck ? eq(jobs.companyKey, ck) : undefined,
      uk ? eq(jobs.urlKey, uk) : undefined,
      // Any Posting of a Job with this URL counts, not only the Posting that created the Job, so a Job that
      // took a copy by company key also takes a later one that shares the copy's URL.
      uk
        ? inArray(
            jobs.id,
            tx
              .select({ id: postings.jobId })
              .from(postings)
              .where(and(eq(postings.userId, userId), eq(postings.urlKey, uk))),
          )
        : undefined,
    );
    let jobId: string | undefined;
    let spare = false;
    let conflict: string[] = [];
    for (let attempt = 0; !jobId && attempt < MAX_ATTEMPTS; attempt += 1) {
      const found = keyMatch
        ? await tx
            .select({ id: jobs.id, into: jobs.mergedInto })
            .from(jobs)
            .where(and(eq(jobs.userId, userId), keyMatch))
            // A share lock waits for an AI merge that is moving this Job's keys and Postings, then rechecks the
            // keys, so a Posting is never attached to a Job that was just folded into another.
            .for('share')
        : [];
      // A Job folded into another by a confirmed AI merge still holds its keys: it stands for the Job it went into.
      const hits = [...new Set(found.map((h) => h.into ?? h.id))].map((id) => ({ id }));
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
      return { jobId: theirs, isNew: false, jobCreated: false };
    }
    if (conflict.length > 0) {
      await tx.insert(mergeConflicts).values({ userId, postingId: posting.id, jobIds: conflict });
    }
    // True only when this call's own insert made the Job; a rule merge attached to an existing one.
    return { jobId, isNew: true, jobCreated: spare };
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
 * thousands. Rule merge only here; the AI merge is in ai-merge.ts.
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
      const jobIds = new Set<string>();
      for (const p of fetched) {
        // One Posting the database refuses is an error line; the rest of the poll goes on. Anything
        // else (a lost connection, an unexpected error) fails the run.
        try {
          const placed = await ingest(db, userId, sourceId, p);
          if (placed.isNew) {
            newPostings += 1;
            jobIds.add(placed.jobId);
          }
        } catch (err) {
          if (!aboutThisPosting(err)) throw err;
          logger?.warn({ err, sourceId, sourcePostingId: p.sourcePostingId }, 'posting not stored');
          errors.push(`posting ${p.sourcePostingId} could not be stored`);
        }
      }
      return { fetched: fetched.length, newPostings, jobIds: [...jobIds], errors };
    },

    async addJob(userId, input) {
      const key = urlKey(input.url);
      if (!key) throw new DiscoveryError('url must be an absolute http or https URL');
      const sourceId = input.source ?? MANUAL_SOURCE;
      let sourcePostingId = key;
      if (sourceId !== MANUAL_SOURCE) {
        const site = siteJobId(input.url);
        if (site?.site !== sourceId) {
          throw new DiscoveryError(`url is not a ${sourceId} job link`);
        }
        sourcePostingId = site.id;
      }
      const { jobId, jobCreated } = await ingest(db, userId, sourceId, {
        sourcePostingId,
        title: input.title,
        company: input.company ?? null,
        location: input.city ?? null,
        url: input.url,
        raw: input,
      });
      const others = await db
        .select({
          sourceId: postings.sourceId,
          publisher: postings.publisher,
          firstSeenAt: postings.firstSeenAt,
        })
        .from(postings)
        .where(
          and(
            eq(postings.userId, userId),
            eq(postings.jobId, jobId),
            or(ne(postings.sourceId, sourceId), ne(postings.sourcePostingId, sourcePostingId)),
          ),
        )
        .orderBy(asc(postings.firstSeenAt), asc(postings.id));
      return { jobId, created: jobCreated, seenBefore: others };
    },

    async splitJob(userId, jobId, postingIds) {
      const ids = [...new Set(postingIds)];
      if (ids.length === 0) throw new DiscoveryError('give at least one posting to split off');
      return db.transaction(async (tx: Tx) => {
        // Locking the Job serializes concurrent splits of it.
        const [job] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId), isNull(jobs.mergedInto)))
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

    async listMatchable(userId, ids) {
      if (ids && ids.length === 0) return [];
      const rows = await db
        .select({ job: jobs, posting: postings })
        .from(jobs)
        .innerJoin(postings, eq(postings.jobId, jobs.id))
        .where(
          and(
            eq(jobs.userId, userId),
            isNull(jobs.mergedInto),
            ids ? inArray(jobs.id, ids) : undefined,
            inArray(jobs.discoveryState, ['new', 'shortlisted']),
          ),
        )
        .orderBy(asc(postings.firstSeenAt));
      const byJob = new Map<string, MatchableJobRow>();
      for (const { job, posting } of rows) {
        if (byJob.has(job.id)) continue; // the oldest Posting speaks for the Job
        byJob.set(job.id, {
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          raw: posting.raw,
          recency: posting.postedAt ?? posting.firstSeenAt,
        });
      }
      return [...byJob.values()];
    },

    async lockJob(tx, userId, jobId) {
      // A Job folded into another by an AI merge is gone for every writer.
      const [job] = await tx
        .select({ discoveryState: jobs.discoveryState })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId), isNull(jobs.mergedInto)))
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
      { limit = DEFAULT_LIMIT, cursor, discoveredSince, discoveryState, jobIds, url },
    ) {
      if (jobIds && jobIds.length === 0) return { jobs: [], nextCursor: null };
      const wantedKey = url === undefined ? undefined : urlKey(url);
      if (wantedKey === null) return { jobs: [], nextCursor: null };
      const size = Math.min(Math.max(limit, 1), MAX_LIMIT);
      const rows = await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.userId, userId),
            isNull(jobs.mergedInto),
            cursor ? gt(jobs.id, cursor) : undefined,
            discoveredSince ? gte(jobs.createdAt, discoveredSince) : undefined,
            discoveryState ? eq(jobs.discoveryState, discoveryState) : undefined,
            // ponytail: every candidate id is a bind parameter (Postgres ceiling about 65k); upgrade:
            // page the candidates first and pass one page of ids.
            jobIds ? inArray(jobs.id, jobIds) : undefined,
            wantedKey
              ? inArray(
                  jobs.id,
                  db
                    .select({ id: postings.jobId })
                    .from(postings)
                    .where(and(eq(postings.userId, userId), eq(postings.urlKey, wantedKey))),
                )
              : undefined,
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
        .where(and(eq(jobs.userId, userId), eq(jobs.id, jobId), isNull(jobs.mergedInto)));
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
