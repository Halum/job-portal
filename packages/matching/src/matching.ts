import { and, asc, eq, gte, inArray, notExists, notInArray, sql } from 'drizzle-orm';
import { AiError, type Ai } from '@job-portal/ai';
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
import {
  buildPrompt,
  judgeLanguage,
  LANGUAGE_CAP,
  parseAssessment,
  type LanguageRequirement,
} from './scoring';
import { candidates, globalDefaults, scores, targets } from './schema';

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
   * Expired Jobs, so Matching never reads another module's tables. Without `ids` it returns every
   * matchable Job of the user (used to rematch a Target that was just created or edited).
   */
  loadJobs: (userId: string, ids?: string[]) => Promise<MatchableJob[]>;
  /** Ids among `ids` that already have an application status; those are skipped. Wired by the Tracker. */
  hasApplication?: (userId: string, ids: string[]) => Promise<Set<string>>;
  /** Used when neither the Target nor the Global defaults set prerankTopN. */
  defaultPrerankTopN?: number;
  /** Scores the prerank survivors; without it `score` does nothing. */
  ai?: Pick<Ai, 'run'>;
  /** Used when neither the Target nor the Global defaults set alertThreshold. */
  defaultAlertThreshold?: number;
  places?: PlaceTable;
}

/** What one scoring pass did. */
export interface ScoreResult {
  /** Pairs that got a score. */
  scored: number;
  /** Of those, the ones at or above the alert threshold (the Job is tagged with the Target). */
  tagged: number;
  /** AI calls made, failed ones included. */
  calls: number;
  /** Sum of the costs the runner reported. */
  costUsd: number;
  /** One line per failed call, with its error class. */
  errors: string[];
}

/** One Job's standing with one Target it is a candidate for. */
export interface JobScore {
  targetId: string;
  targetName: string;
  prerankScore: number;
  /** The place could not be resolved, so the radius was not checked. */
  unknownLocation: boolean;
  /** null while unscored. */
  score: number | null;
  reasons: string[];
  redFlags: string[];
  languages: LanguageRequirement[];
  languageMet: boolean | null;
  tagged: boolean;
}

export interface Matching {
  /** Hard filters and prerank for each active Target over the given Jobs; returns how many passed in total. */
  run: (userId: string, jobIds: string[]) => Promise<{ prerankPassed: number }>;
  listTargets: (userId: string) => Promise<TargetView[]>;
  /**
   * Creates the Target or updates the one with this name; criteria keys not given keep their value, null clears one.
   * Then rematches it over every matchable Job and replaces its candidates (a paused Target keeps none).
   */
  upsertTarget: (userId: string, input: UpsertTargetInput) => Promise<TargetView>;
  getGlobalDefaults: (userId: string) => Promise<Criteria>;
  updateGlobalDefaults: (userId: string, patch: CriteriaPatch) => Promise<Criteria>;
  /** Ids of the Jobs that passed the filters and prerank of a Target, for list_jobs. */
  listJobIds: (
    userId: string,
    filter: { targetId: string; minScore?: number },
  ) => Promise<string[]>;
  /**
   * Scores every unscored candidate of an active Target, oldest first, whichever run made it, so a
   * failed pair is retried by the next pass. A pair another worker holds is skipped, so two workers
   * never score the same pair twice. Stops after three failures in a row.
   */
  score: (userId: string) => Promise<ScoreResult>;
  /** The Job's score and tag for each Target it is a candidate for. */
  listScores: (userId: string, jobId: string) => Promise<JobScore[]>;
  /** Search parameters for the active Targets: one per keyword and location, none for a Target that sets neither. */
  searchQueries: (userId: string) => Promise<SearchQuery[]>;
}

const DEFAULT_TOP_N = 20;
const DEFAULT_ALERT_THRESHOLD = 70;
/** A dead runner fails every call; this many in a row ends the pass. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Most search requests one fetch makes (keywords x places over all active Targets). */
export const MAX_QUERIES = 50;

const read = (stored: unknown): Criteria =>
  criteriaSchema.parse({ ...emptyCriteria(), ...(stored as object) });

export function createMatching(
  db: Db,
  {
    loadJobs,
    hasApplication,
    defaultPrerankTopN = DEFAULT_TOP_N,
    ai,
    defaultAlertThreshold = DEFAULT_ALERT_THRESHOLD,
    places,
  }: MatchingDeps,
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

  /** Jobs Matching may look at (all of the user's when `jobIds` is not given), minus those with an application status. */
  const matchable = async (userId: string, jobIds?: string[]): Promise<MatchableJob[]> => {
    const jobs = await loadJobs(userId, jobIds);
    if (!hasApplication || jobs.length === 0) return jobs;
    const blocked = await hasApplication(
      userId,
      jobs.map((j) => j.id),
    );
    return jobs.filter((j) => !blocked.has(j.id));
  };

  /** The Jobs that pass a Target's hard filters and prerank. */
  const topFor = (c: ResolvedCriteria, jobs: MatchableJob[]) => {
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
    return prerank(scored, c.prerankTopN ?? defaultPrerankTopN, (c.keywords ?? []).length > 0);
  };

  const insertCandidates = async (
    tx: Pick<Db, 'insert'>,
    userId: string,
    targetId: string,
    top: ReturnType<typeof topFor>,
  ): Promise<void> => {
    if (top.length === 0) return;
    await tx
      .insert(candidates)
      .values(
        top.map((s) => ({
          userId,
          targetId,
          jobId: s.job.id,
          prerankScore: s.score,
          unknownLocation: s.unknownLocation,
        })),
      )
      .onConflictDoNothing();
  };

  /**
   * Jobs stored before an edit never reach `run` again, so an edited Target is matched over all of them
   * and its candidates replaced. The caller holds the Target's row lock and runs this in its transaction.
   */
  const rematch = async (
    tx: Pick<Db, 'insert' | 'delete'>,
    userId: string,
    globals: Criteria,
    target: typeof targets.$inferSelect,
  ): Promise<void> => {
    await tx.delete(candidates).where(eq(candidates.targetId, target.id));
    if (target.paused) return;
    await insertCandidates(
      tx,
      userId,
      target.id,
      topFor(view(globals, target).resolved, await matchable(userId)),
    );
  };

  return {
    async run(userId, jobIds) {
      if (jobIds.length === 0) return { prerankPassed: 0 };
      const jobs = await matchable(userId, jobIds);
      const globals = await getGlobals(userId);
      let prerankPassed = 0;
      for (const { id } of await activeTargets(userId)) {
        // The Target row lock keeps a run from adding candidates computed from criteria a concurrent
        // edit has just replaced; the criteria are read again under the lock.
        prerankPassed += await db.transaction(async (tx) => {
          const [row] = await tx.select().from(targets).where(eq(targets.id, id)).for('update');
          if (!row || row.paused) return 0;
          const top = topFor(view(globals, row).resolved, jobs);
          await insertCandidates(tx, userId, id, top);
          return top.length;
        });
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
        await rematch(tx, userId, await getGlobals(userId), saved);
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
        // Targets inherit from the defaults, so each one is matched again under its own row lock.
        // (upsertTarget locks only its Target row and reads the defaults without a lock, so no lock cycle.)
        const rows = await tx
          .select()
          .from(targets)
          .where(and(eq(targets.userId, userId), eq(targets.paused, false)))
          .orderBy(asc(targets.name))
          .for('update');
        for (const t of rows) await rematch(tx, userId, next, t);
        return next;
      });
    },

    async listJobIds(userId, { targetId, minScore }) {
      const where = and(eq(candidates.userId, userId), eq(candidates.targetId, targetId));
      // minScore 0 is a real filter (it needs a score), so it is tested against undefined, not falsy.
      const rows =
        minScore === undefined
          ? await db.select({ jobId: candidates.jobId }).from(candidates).where(where)
          : await db
              .select({ jobId: candidates.jobId })
              .from(candidates)
              .innerJoin(
                scores,
                and(eq(scores.targetId, candidates.targetId), eq(scores.jobId, candidates.jobId)),
              )
              .where(and(where, gte(scores.score, minScore)));
      return rows.map((r) => r.jobId);
    },

    async listScores(userId, jobId) {
      const rows = await db
        .select({ c: candidates, t: targets.name, s: scores })
        .from(candidates)
        .innerJoin(targets, eq(targets.id, candidates.targetId))
        .leftJoin(
          scores,
          and(eq(scores.targetId, candidates.targetId), eq(scores.jobId, candidates.jobId)),
        )
        .where(and(eq(candidates.userId, userId), eq(candidates.jobId, jobId)))
        .orderBy(asc(targets.name));
      return rows.map(({ c, t, s }) => ({
        targetId: c.targetId,
        targetName: t,
        prerankScore: c.prerankScore,
        unknownLocation: c.unknownLocation,
        score: s?.score ?? null,
        reasons: s?.reasons ?? [],
        redFlags: s?.redFlags ?? [],
        languages: s?.languages ?? [],
        languageMet: s?.languageMet ?? null,
        tagged: s?.tagged ?? false,
      }));
    },

    async score(userId) {
      const result: ScoreResult = { scored: 0, tagged: 0, calls: 0, costUsd: 0, errors: [] };
      if (!ai) return result;
      const globals = await getGlobals(userId);
      /** Candidates this pass has already looked at, so a failed or skipped one is not picked again. */
      const seen: string[] = [];
      let failuresInARow = 0;
      while (failuresInARow < MAX_CONSECUTIVE_FAILURES) {
        // The row lock is held through the AI call: it keeps a second worker off this pair and is
        // released by the database if this worker dies. ponytail: one connection per call in flight.
        const step = await db.transaction(
          async (tx): Promise<'none' | 'skipped' | 'scored' | 'failed'> => {
            const [picked] = await tx
              .select()
              .from(candidates)
              .where(
                and(
                  eq(candidates.userId, userId),
                  inArray(
                    candidates.targetId,
                    tx.select({ id: targets.id }).from(targets).where(eq(targets.paused, false)),
                  ),
                  seen.length > 0 ? notInArray(candidates.id, seen) : undefined,
                  notExists(
                    tx
                      .select({ one: sql`1` })
                      .from(scores)
                      .where(
                        and(
                          eq(scores.targetId, candidates.targetId),
                          eq(scores.jobId, candidates.jobId),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(asc(candidates.createdAt), asc(candidates.id))
              .limit(1)
              .for('update', { skipLocked: true });
            if (!picked) return 'none';
            seen.push(picked.id);
            const [targetRow] = await tx
              .select()
              .from(targets)
              .where(eq(targets.id, picked.targetId));
            if (!targetRow) return 'skipped';
            const row = { c: picked, t: targetRow };
            // The lock does not see a score another worker committed after our query began: look again.
            const [already] = await tx
              .select({ id: scores.id })
              .from(scores)
              .where(and(eq(scores.targetId, row.c.targetId), eq(scores.jobId, row.c.jobId)));
            if (already) return 'skipped';
            const [job] = await matchable(userId, [row.c.jobId]);
            if (!job) return 'skipped';
            const criteria = resolveCriteria(globals, read(row.t.criteria));
            result.calls += 1;
            let assessed;
            try {
              assessed = await ai.run(
                userId,
                'fit_score',
                buildPrompt(criteria, job),
                parseAssessment,
              );
            } catch (err) {
              const cls = err instanceof AiError ? err.errorClass : 'unexpected';
              result.errors.push(`fit score failed (${cls}) for a Job and Target`);
              return 'failed';
            }
            result.costUsd += assessed.costUsd ?? 0;
            const { score: raw, reasons, redFlags, languages } = assessed.value;
            const { met, unmet } = judgeLanguage(criteria.languageAbility, languages);
            const score = met === false ? Math.min(raw, LANGUAGE_CAP) : raw;
            const flags =
              met === false
                ? [...redFlags, `language requirement not met: ${unmet.join(', ')}`]
                : redFlags;
            const tagged = score >= (criteria.alertThreshold ?? defaultAlertThreshold);
            await tx
              .insert(scores)
              .values({
                userId,
                targetId: row.c.targetId,
                jobId: row.c.jobId,
                score,
                reasons,
                redFlags: flags,
                languages,
                languageMet: met,
                tagged,
              })
              .onConflictDoNothing();
            result.scored += 1;
            if (tagged) result.tagged += 1;
            return 'scored';
          },
        );
        if (step === 'none') break;
        failuresInARow = step === 'failed' ? failuresInARow + 1 : 0;
      }
      return result;
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
      // ponytail: first MAX_QUERIES in Target name order; a fair split per Target if someone needs more than that.
      return [...seen.values()].slice(0, MAX_QUERIES);
    },
  };
}
