import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Source } from './source';
import { jobs, postings } from './schema';

export interface PollResult {
  fetched: number;
  newPostings: number;
  errors: string[];
}

export interface PostingView {
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
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const postingColumns = {
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

/**
 * ponytail: one Job per Posting for now and one query per posting. Dedupe (rule and AI merges)
 * and batching arrive with the Discovery dedupe ticket; polls hold tens of postings, not thousands.
 */
export function createDiscovery(db: Db, sources: Source[]): Discovery {
  const byId = new Map(sources.map((s) => [s.id, s]));

  return {
    async poll(userId, sourceId) {
      const source = byId.get(sourceId);
      if (!source) throw new Error(`unknown source: ${sourceId}`);
      const { postings: fetched, errors } = await source.fetch();

      let newPostings = 0;
      await db.transaction(async (tx) => {
        for (const p of fetched) {
          const [job] = await tx
            .insert(jobs)
            .values({ userId, title: p.title, company: p.company, location: p.location })
            .returning({ id: jobs.id });
          if (!job) throw new Error('job insert returned no row');
          const values = {
            title: p.title,
            company: p.company ?? null,
            location: p.location ?? null,
            url: p.url,
            postedAt: p.postedAt ?? null,
            raw: p.raw,
          };
          // Insert, or update on the identity (user, source, source posting id). xmax is 0 only
          // for a row this statement inserted.
          const [row] = await tx
            .insert(postings)
            .values({
              userId,
              sourceId,
              sourcePostingId: p.sourcePostingId,
              jobId: job.id,
              ...values,
            })
            .onConflictDoUpdate({
              target: [postings.userId, postings.sourceId, postings.sourcePostingId],
              set: { ...values, lastSeenAt: sql`now()` },
            })
            .returning({ inserted: sql<boolean>`(xmax = 0)` });
          if (row?.inserted) newPostings += 1;
          else await tx.delete(jobs).where(eq(jobs.id, job.id)); // seen before: drop the spare Job
        }
      });
      return { fetched: fetched.length, newPostings, errors };
    },

    async listJobs(userId, { limit = DEFAULT_LIMIT, cursor }) {
      const size = Math.min(Math.max(limit, 1), MAX_LIMIT);
      const rows = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, userId), cursor ? gt(jobs.id, cursor) : undefined))
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
          id: j.id,
          title: j.title,
          company: j.company,
          location: j.location,
          createdAt: j.createdAt,
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
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        createdAt: job.createdAt,
        postings: ps,
      };
    },
  };
}
