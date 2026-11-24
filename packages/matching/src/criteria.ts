import { z } from 'zod';

export const MAX_WORDS = 50;
export const MAX_WORD_LENGTH = 100;
const words = z.array(z.string().trim().min(1).max(MAX_WORD_LENGTH)).max(MAX_WORDS).nullable();

/**
 * The search criteria of Global defaults and of every Target. Every field is nullable: null means
 * unset (a Target inherits the Global default), never a falsy check, so 0 and false are real values.
 */
export const criteriaSchema = z.object({
  keywords: words,
  exclusionWords: words,
  blockedCompanies: words,
  /** Places (city names or postcodes) jobs should be near. */
  locations: words,
  /** Kilometres around each location; 0 means the same city only. */
  radiusKm: z.number().int().min(0).max(500).nullable(),
  /** False drops remote postings, true lets them past the location check, null does not care. */
  remoteAllowed: z.boolean().nullable(),
  /** 0 means no floor. */
  salaryFloor: z.number().int().min(0).max(10_000_000).nullable(),
  /** Used by AI scoring; 0 lets everything through. */
  alertThreshold: z.number().int().min(0).max(100).nullable(),
  /** What the user can speak, for the AI fit score, for example "de:A2". */
  languageAbility: words,
  /** Integer from 1 to 200. */
  prerankTopN: z.number().int().min(1).max(200).nullable(),
  /**
   * Days without a status change before an application goes Gone cold; null disables the check. A Global
   * default only: the Tracker's check reads it from the defaults, so on a Target it has no effect.
   */
  goneColdDays: z.number().int().min(1).nullable(),
});

export type Criteria = z.infer<typeof criteriaSchema>;

/** A partial update: a missing key keeps the stored value, null clears it back to unset. */
export const criteriaPatchSchema = criteriaSchema.partial();
export type CriteriaPatch = z.infer<typeof criteriaPatchSchema>;

export const emptyCriteria = (): Criteria => ({
  keywords: null,
  exclusionWords: null,
  blockedCompanies: null,
  locations: null,
  radiusKm: null,
  remoteAllowed: null,
  salaryFloor: null,
  alertThreshold: null,
  languageAbility: null,
  prerankTopN: null,
  goneColdDays: null,
});

export function applyPatch(base: Criteria, patch: CriteriaPatch): Criteria {
  const next: Criteria = { ...base };
  for (const key of Object.keys(patch) as (keyof Criteria)[]) {
    const value = patch[key];
    if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return criteriaSchema.parse(next);
}

const union = (a: string[] | null, b: string[] | null): string[] => {
  const seen = new Map<string, string>();
  for (const w of [...(a ?? []), ...(b ?? [])]) {
    const key = w.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()];
};

/** Criteria after resolution: exclusions are always lists, everything else may still be null. */
export type ResolvedCriteria = Omit<Criteria, 'exclusionWords' | 'blockedCompanies'> & {
  exclusionWords: string[];
  blockedCompanies: string[];
};

/**
 * Criteria resolution: a Target field that is set (not null) replaces the Global default, an unset
 * one falls back to it; exclusion words and blocked companies are the union of both.
 */
export function resolveCriteria(globals: Criteria, target: Criteria): ResolvedCriteria {
  const pick = <K extends keyof Criteria>(key: K): Criteria[K] =>
    target[key] !== null ? target[key] : globals[key];
  return {
    keywords: pick('keywords'),
    locations: pick('locations'),
    radiusKm: pick('radiusKm'),
    remoteAllowed: pick('remoteAllowed'),
    salaryFloor: pick('salaryFloor'),
    alertThreshold: pick('alertThreshold'),
    languageAbility: pick('languageAbility'),
    prerankTopN: pick('prerankTopN'),
    goneColdDays: pick('goneColdDays'),
    exclusionWords: union(globals.exclusionWords, target.exclusionWords),
    blockedCompanies: union(globals.blockedCompanies, target.blockedCompanies),
  };
}
