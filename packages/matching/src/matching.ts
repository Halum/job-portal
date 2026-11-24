import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import {
  applyPatch,
  criteriaSchema,
  emptyCriteria,
  resolveCriteria,
  type Criteria,
  type CriteriaPatch,
  type ResolvedCriteria,
} from './criteria';
import { hardFilter, prerank, prerankScore, type MatchableJob } from './filters';
import { germanPlaces, type PlaceTable } from './places';
import { candidates, globalDefaults, targets } from './schema';

export interface TargetView {
  id: string;
  name: string;
  paused: boolean;
  /** The fields set on the Target itself; null means inherit. */
  criteria: Criteria;
  /** What the Target uses after falling back to the Global defaults. */
  resolved: ResolvedCriteria;
}

export interface UpsertTargetInput {
  name: string;
  paused?: boolean;
  criteria?: CriteriaPatch;
}

/** One request's worth of search parameters for a Source that searches by text and place. */
export interface SearchQuery {
  was?: string;
  wo?: string;
  umkreis?: number;
}

export interface MatchingDeps {
  /**
   * The Jobs among `ids` that may be matched. Discovery supplies it and leaves out Dismissed and
   * Expired Jobs, so Matching never reads another module's tables.
   */
  loadJobs: (userId: string, ids: string[]) => Promise<MatchableJob[]>;
  /** Ids among `ids` that already have an application status; those are skipped. Wired by the Tracker. */
  hasApplication?: (userId: string, ids: string[]) => Promise<Set<string>>;
  /** Used when neither the Target nor the Global defaults set prerankTopN. */
  defaultPrerankTopN?: number;
  places?: PlaceTable;
}

export interface Matching {
  /** Hard filters and prerank for each active Target over the given Jobs; returns how many passed in total. */
  run: (userId: string, jobIds: string[]) => Promise<{ prerankPassed: number }>;
  listTargets: (userId: string) => Promise<TargetView[]>;
  /** Creates the Target or updates the one with this name; criteria keys not given keep their value, null clears one. */
  upsertTarget: (userId: string, input: UpsertTargetInput) => Promise<TargetView>;
  getGlobalDefaults: (userId: string) => Promise<Criteria>;
  updateGlobalDefaults: (userId: string, patch: CriteriaPatch) => Promise<Criteria>;
  /** Ids of the Jobs that passed the filters and prerank of a Target, for list_jobs. */
  listJobIds: (userId: string, filter: { targetId: string }) => Promise<string[]>;
  /** Search parameters for the active Targets: one per keyword and location, none for a Target that sets neither. */
  searchQueries: (userId: string) => Promise<SearchQuery[]>;
}

const DEFAULT_TOP_N = 20;

const read = (stored: unknown): Criteria =>
  criteriaSchema.parse({ ...emptyCriteria(), ...(stored as object) });

export function createMatching(
  db: Db,
  { loadJobs, hasApplication, defaultPrerankTopN = DEFAULT_TOP_N, places }: MatchingDeps,
): Matching {
  const table = places ?? germanPlaces();

  const getGlobals = async (userId: string): Promise<Criteria> => {
    const [row] = await db.select().from(globalDefaults).where(eq(globalDefaults.userId, userId));
    return row ? read(row.criteria) : emptyCriteria();
  };

  const view = (globals: Criteria, t: typeof targets.$inferSelect): TargetView => {
    const criteria = read(t.criteria);
    return {
      id: t.id,
      name: t.name,
      paused: t.paused,
      criteria,
      resolved: resolveCriteria(globals, criteria),
    };
  };

  const activeTargets = async (userId: string): Promise<TargetView[]> => {
    const globals = await getGlobals(userId);
    const rows = await db
      .select()
      .from(targets)
      .where(and(eq(targets.userId, userId), eq(targets.paused, false)))
      .orderBy(asc(targets.name));
    return rows.map((t) => view(globals, t));
  };

  return {
    async run(userId, jobIds) {
      if (jobIds.length === 0) return { prerankPassed: 0 };
      const blocked = hasApplication ? await hasApplication(userId, jobIds) : new Set<string>();
      const jobs = (await loadJobs(userId, jobIds)).filter((j) => !blocked.has(j.id));
      let prerankPassed = 0;
      for (const target of await activeTargets(userId)) {
        const c = target.resolved;
        const scored = jobs.flatMap((job) => {
          const outcome = hardFilter(job, c, table);
          return outcome.pass
            ? [
                {
                  job,
                  unknownLocation: outcome.unknownLocation,
                  score: prerankScore(job, c.keywords ?? []),
                },
              ]
            : [];
        });
        const top = prerank(
          scored,
          c.prerankTopN ?? defaultPrerankTopN,
          (c.keywords ?? []).length > 0,
        );
        if (top.length > 0) {
          await db
            .insert(candidates)
            .values(
              top.map((s) => ({
                userId,
                targetId: target.id,
                jobId: s.job.id,
                prerankScore: s.score,
                unknownLocation: s.unknownLocation,
              })),
            )
            .onConflictDoNothing();
        }
        prerankPassed += top.length;
      }
      return { prerankPassed };
    },

    async listTargets(userId) {
      const globals = await getGlobals(userId);
      const rows = await db
        .select()
        .from(targets)
        .where(eq(targets.userId, userId))
        .orderBy(asc(targets.name));
      return rows.map((t) => view(globals, t));
    },

    async upsertTarget(userId, { name, paused, criteria }) {
      const patch = criteria ?? {};
      const updated = await db.transaction(async (tx) => {
        // The row lock serializes two edits of the same Target, so neither patch is lost.
        await tx
          .insert(targets)
          .values({ userId, name, criteria: emptyCriteria() })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(targets)
          .where(and(eq(targets.userId, userId), eq(targets.name, name)))
          .for('update');
        if (!row) throw new Error('target vanished during upsert');
        const [saved] = await tx
          .update(targets)
          .set({
            criteria: applyPatch(read(row.criteria), patch),
            paused: paused ?? row.paused,
            updatedAt: new Date(),
          })
          .where(eq(targets.id, row.id))
          .returning();
        if (!saved) throw new Error('target update returned no row');
        return saved;
      });
      return view(await getGlobals(userId), updated);
    },

    getGlobalDefaults: getGlobals,

    async updateGlobalDefaults(userId, patch) {
      return db.transaction(async (tx) => {
        await tx
          .insert(globalDefaults)
          .values({ userId, criteria: emptyCriteria() })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(globalDefaults)
          .where(eq(globalDefaults.userId, userId))
          .for('update');
        const next = applyPatch(read(row?.criteria), patch);
        await tx
          .update(globalDefaults)
          .set({ criteria: next, updatedAt: new Date() })
          .where(eq(globalDefaults.userId, userId));
        return next;
      });
    },

    async listJobIds(userId, { targetId }) {
      const rows = await db
        .select({ jobId: candidates.jobId })
        .from(candidates)
        .where(and(eq(candidates.userId, userId), eq(candidates.targetId, targetId)));
      return rows.map((r) => r.jobId);
    },

    async searchQueries(userId) {
      const seen = new Map<string, SearchQuery>();
      for (const { resolved: c } of await activeTargets(userId)) {
        const words = c.keywords ?? [];
        const places = c.locations ?? [];
        if (words.length === 0 && places.length === 0) continue; // nothing to search for
        for (const was of words.length > 0 ? words : [undefined]) {
          for (const wo of places.length > 0 ? places : [undefined]) {
            const q: SearchQuery = {
              ...(was === undefined ? {} : { was }),
              ...(wo === undefined ? {} : { wo }),
              ...(wo !== undefined && c.radiusKm !== null ? { umkreis: c.radiusKm } : {}),
            };
            seen.set(JSON.stringify(q), q);
          }
        }
      }
      return [...seen.values()];
    },
  };
}
