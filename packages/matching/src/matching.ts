import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { AiError, isRunnerWide, type Ai } from '@job-portal/ai';
import type { Db } from '@job-portal/db';
import { fitRejectionSubject, type Review, type ReviewDecision } from '@job-portal/review';
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
import { candidates, globalDefaults, scores, tagOverrides, targets } from './schema';

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
  /** Receives an item for each score below the threshold; without it nothing is raised. */
  review?: Pick<Review, 'create'>;
  /** Used when neither the Target nor the Global defaults set alertThreshold. */
  defaultAlertThreshold?: number;
  /**
   * Most AI calls one scoring pass makes (a throughput limit, not a spend cap): the pairs left over wait
   * for the next pass, oldest first, so nothing is dropped. Default 50.
   */
  maxCallsPerPass?: number;
  places?: PlaceTable;
}

/** What one scoring pass did. */
export interface ScoreResult {
  /** Pairs that got a score. */
  scored: number;
  /** Of those, the ones at or above the alert threshold (the Job is tagged with the Target). */
  tagged: number;
  /** Review items raised for scores below the threshold (not counting ones that already existed). */
  rejections: number;
  /** AI calls made, failed ones included. */
  calls: number;
  /** Sum of the costs the runner reported; null when no call reported one (unknown, not 0). */
  costUsd: number | null;
  /** One line per failed call, with its error class. */
  errors: string[];
}

/** A pass that did nothing. */
export const emptyScoreResult = (): ScoreResult => ({
  scored: 0,
  tagged: 0,
  rejections: 0,
  calls: 0,
  costUsd: null,
  errors: [],
});

/** A Job and Target pair that is tagged now and is new to a digest. */
export interface NewTag {
  jobId: string;
  targetId: string;
  targetName: string;
  /** null only for an override on a pair that was never scored. */
  score: number | null;
  reasons: string[];
  /** The user disagreed with an AI fit rejection, so the pair is tagged whatever its score. */
  override: boolean;
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
    filter: { targetId: string; minScore?: number; tagged?: boolean },
  ) => Promise<string[]>;
  /**
   * Scores every unscored candidate of an active Target, oldest first, whichever run made it, so a
   * failed pair is retried by the next pass. A pair another worker holds is skipped, so two workers
   * never score the same pair twice. Stops after three failures in a row.
   */
  score: (userId: string) => Promise<ScoreResult>;
  /**
   * Applies a decided ai_fit_rejection item inside the decision's transaction: a disagreement tags the Job
   * with the Target (a stored override, so the tag survives threshold edits), a confirmation changes nothing.
   * Idempotent. Throws when the subject is not a Job and Target pair.
   */
  applyFitRejection: (
    tx: Pick<Db, 'insert' | 'select'>,
    userId: string,
    subject: Record<string, string>,
    decision: ReviewDecision,
  ) => Promise<void>;
  /**
   * The Job's score and tag for each Target it is a candidate for. The tag is derived on every read: a
   * score at or above the threshold the Target resolves to now, so editing a threshold retags without a new call.
   */
  listScores: (userId: string, jobId: string) => Promise<JobScore[]>;
  /**
   * The pairs tagged now that were scored at or after `since`, plus every tag override whatever its date (the
   * caller, the digest, remembers which pairs it already listed). Candidates of active Targets only; a pair
   * whose score fell under a raised threshold is not listed.
   */
  listNewTags: (userId: string, since: Date) => Promise<NewTag[]>;
  /** Search parameters for the active Targets: one per keyword and location, none for a Target that sets neither. */
  searchQueries: (userId: string) => Promise<SearchQuery[]>;
}

const DEFAULT_TOP_N = 20;
const DEFAULT_ALERT_THRESHOLD = 70;
const DEFAULT_MAX_CALLS_PER_PASS = 50;
/** A dead runner fails every call; this many runner-wide failures in a row end the pass. */
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
    review,
    defaultAlertThreshold = DEFAULT_ALERT_THRESHOLD,
    maxCallsPerPass = DEFAULT_MAX_CALLS_PER_PASS,
    places,
  }: MatchingDeps,
): Matching {
  const table = places ?? germanPlaces();

  const getGlobals = async (userId: string): Promise<Criteria> => {
    const [row] = await db.select().from(globalDefaults).where(eq(globalDefaults.userId, userId));
    return row ? read(row.criteria) : emptyCriteria();
  };

  /** The alert threshold a Target uses: its own, then the Global default, then the configured one. 0 is real. */
  const thresholdOf = (globals: Criteria, target: Criteria): number =>
    resolveCriteria(globals, target).alertThreshold ?? defaultAlertThreshold;

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

    async listJobIds(userId, { targetId, minScore, tagged }) {
      const where = and(eq(candidates.userId, userId), eq(candidates.targetId, targetId));
      // minScore 0 is a real filter (it needs a score), so it is tested against undefined, not falsy.
      const conditions = [];
      if (minScore !== undefined) conditions.push(gte(scores.score, minScore));
      if (tagged !== undefined) {
        const [t] = await db
          .select()
          .from(targets)
          .where(and(eq(targets.id, targetId), eq(targets.userId, userId)));
        if (!t) return [];
        const threshold = thresholdOf(await getGlobals(userId), read(t.criteria));
        // A Job with a tag override (the user disagreed with its rejection) is tagged whatever its score.
        conditions.push(
          tagged
            ? or(gte(scores.score, threshold), isNotNull(tagOverrides.id))
            : and(lt(scores.score, threshold), isNull(tagOverrides.id)),
        );
      }
      const rows =
        conditions.length === 0
          ? await db.select({ jobId: candidates.jobId }).from(candidates).where(where)
          : await db
              .select({ jobId: candidates.jobId })
              .from(candidates)
              .innerJoin(
                scores,
                and(eq(scores.targetId, candidates.targetId), eq(scores.jobId, candidates.jobId)),
              )
              .leftJoin(
                tagOverrides,
                and(
                  eq(tagOverrides.userId, candidates.userId),
                  eq(tagOverrides.targetId, candidates.targetId),
                  eq(tagOverrides.jobId, candidates.jobId),
                ),
              )
              .where(and(where, ...conditions));
      return rows.map((r) => r.jobId);
    },

    async listScores(userId, jobId) {
      const rows = await db
        .select({ c: candidates, t: targets, s: scores, o: tagOverrides.id })
        .from(candidates)
        .innerJoin(targets, eq(targets.id, candidates.targetId))
        .leftJoin(
          scores,
          and(eq(scores.targetId, candidates.targetId), eq(scores.jobId, candidates.jobId)),
        )
        .leftJoin(
          tagOverrides,
          and(
            eq(tagOverrides.userId, candidates.userId),
            eq(tagOverrides.targetId, candidates.targetId),
            eq(tagOverrides.jobId, candidates.jobId),
          ),
        )
        .where(and(eq(candidates.userId, userId), eq(candidates.jobId, jobId)))
        .orderBy(asc(targets.name));
      const globals = await getGlobals(userId);
      return rows.map(({ c, t, s, o }) => ({
        targetId: c.targetId,
        targetName: t.name,
        prerankScore: c.prerankScore,
        unknownLocation: c.unknownLocation,
        score: s?.score ?? null,
        reasons: s?.reasons ?? [],
        redFlags: s?.redFlags ?? [],
        languages: s?.languages ?? [],
        languageMet: s?.languageMet ?? null,
        tagged: o !== null || (s !== null && s.score >= thresholdOf(globals, read(t.criteria))),
      }));
    },

    async listNewTags(userId, since) {
      const rows = await db
        .select({ jobId: candidates.jobId, t: targets, s: scores, o: tagOverrides.id })
        .from(candidates)
        .innerJoin(targets, eq(targets.id, candidates.targetId))
        .leftJoin(
          scores,
          and(eq(scores.targetId, candidates.targetId), eq(scores.jobId, candidates.jobId)),
        )
        .leftJoin(
          tagOverrides,
          and(
            eq(tagOverrides.userId, candidates.userId),
            eq(tagOverrides.targetId, candidates.targetId),
            eq(tagOverrides.jobId, candidates.jobId),
          ),
        )
        .where(and(eq(candidates.userId, userId), eq(targets.paused, false)))
        .orderBy(asc(candidates.jobId), asc(targets.name));
      const globals = await getGlobals(userId);
      return rows.flatMap(({ jobId, t, s, o }) => {
        const override = o !== null;
        const byScore =
          s !== null && s.scoredAt >= since && s.score >= thresholdOf(globals, read(t.criteria));
        if (!override && !byScore) return [];
        return [
          {
            jobId,
            targetId: t.id,
            targetName: t.name,
            score: s?.score ?? null,
            reasons: s?.reasons ?? [],
            override,
          },
        ];
      });
    },

    async applyFitRejection(tx, userId, subject, decision) {
      const { jobId, targetId } = fitRejectionSubject.parse(subject);
      if (decision === 'confirm') return;
      // The subject comes from the user's own item, but the module that writes an override checks it.
      const [owned] = await tx
        .select({ id: targets.id })
        .from(targets)
        .where(and(eq(targets.id, targetId), eq(targets.userId, userId)));
      if (!owned) throw new Error("the Target of this item is not the user's");
      await tx.insert(tagOverrides).values({ userId, targetId, jobId }).onConflictDoNothing();
    },

    async score(userId) {
      const result = emptyScoreResult();
      if (!ai) return result;
      const globals = await getGlobals(userId);
      /** Candidates this pass has already looked at, so a failed or skipped one is not picked again. */
      const seen: string[] = [];
      /** Failures in a row that say the runner is down (key, cap, login, network); a bad answer for one posting does not count. */
      let runnerFailuresInARow = 0;
      while (runnerFailuresInARow < MAX_CONSECUTIVE_FAILURES && result.calls < maxCallsPerPass) {
        // The row lock is held through the AI call: it keeps a second worker off this pair and is
        // released by the database if this worker dies. ponytail: one connection per call in flight;
        // a lease column (claimed_at) would free the connection during the call if the pool ever runs short.
        const step = await db.transaction(
          async (tx): Promise<'none' | 'skipped' | 'scored' | 'pair_failed' | 'runner_failed'> => {
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
              // Pairs that failed on their own go behind the ones that have not, then oldest first, so a
              // posting the model cannot answer never starves the newer ones.
              .orderBy(asc(candidates.attempts), asc(candidates.createdAt), asc(candidates.id))
              .limit(1)
              .for('update', { skipLocked: true });
            if (!picked) return 'none';
            seen.push(picked.id);
            const [target] = await tx.select().from(targets).where(eq(targets.id, picked.targetId));
            if (!target) return 'skipped';
            // The lock does not see a score another worker committed after our query began: look again.
            const [already] = await tx
              .select({ id: scores.id })
              .from(scores)
              .where(and(eq(scores.targetId, picked.targetId), eq(scores.jobId, picked.jobId)));
            if (already) return 'skipped';
            const [job] = await matchable(userId, [picked.jobId]);
            if (!job) return 'skipped';
            const targetCriteria = read(target.criteria);
            const criteria = resolveCriteria(globals, targetCriteria);
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
              const cls = err instanceof AiError ? err.errorClass : 'request';
              result.errors.push(`fit score failed (${cls}) for a Job and Target`);
              if (isRunnerWide(cls)) return 'runner_failed';
              await tx
                .update(candidates)
                .set({ attempts: sql`${candidates.attempts} + 1` })
                .where(eq(candidates.id, picked.id));
              return 'pair_failed';
            }
            // null stays null (unknown) until some call reports a cost; 0 is a real cost.
            if (assessed.costUsd !== null)
              result.costUsd = (result.costUsd ?? 0) + assessed.costUsd;
            const { score: raw, reasons, redFlags, languages } = assessed.value;
            const { met, unmet } = judgeLanguage(criteria.languageAbility, languages);
            const score = met === false ? Math.min(raw, LANGUAGE_CAP) : raw;
            const flags =
              met === false
                ? [...redFlags, `language requirement not met: ${unmet.join(', ')}`]
                : redFlags;
            await tx
              .insert(scores)
              .values({
                userId,
                targetId: picked.targetId,
                jobId: picked.jobId,
                score,
                reasons,
                redFlags: flags,
                languages,
                languageMet: met,
              })
              .onConflictDoNothing();
            result.scored += 1;
            // Only the score is stored: the tag is derived when read (see listScores). This count is the run's.
            if (score >= thresholdOf(globals, targetCriteria)) {
              result.tagged += 1;
            } else if (review) {
              // Same transaction as the score: a crash cannot leave a rejected pair without its item.
              const item = await review.create(
                userId,
                {
                  kind: 'ai_fit_rejection',
                  subject: { jobId: picked.jobId, targetId: picked.targetId },
                  model: assessed.model,
                },
                tx,
              );
              if (item.created) result.rejections += 1;
            }
            return 'scored';
          },
        );
        if (step === 'none') break;
        runnerFailuresInARow = step === 'runner_failed' ? runnerFailuresInARow + 1 : 0;
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
