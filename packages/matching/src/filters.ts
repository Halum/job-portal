import type { ResolvedCriteria } from './criteria';
import { distanceKm, type PlaceTable } from './places';

export interface MatchableJob {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  /** The Source's own payload, searched by the prerank. */
  raw: unknown;
  /** When the posting appeared, newest wins a prerank tie. */
  recency: Date;
}

export interface FilterOutcome {
  pass: boolean;
  /** True when the place could not be resolved: the job passes but the user should look at it. */
  unknownLocation: boolean;
}

// A remote marker stands alone: at the start or after a separator or bracket, and before the end,
// a separator or bracket ("Berlin (Remote)", "Engineer - Remote", "Remote, Germany"), or as "fully
// remote" or "remote-first". "Remote Sensing Engineer" and "not remote" are therefore not remote.
const REMOTE_WORD =
  /(?:^|[([)\-\u2013\u2014|,/:]\s*|\b(?:fully|full|100%)\s+)remote(?=\s*(?:$|[)\]\-\u2013\u2014|,/:]))|\bremote[\s-]first\b/i;
const HOME_OFFICE =
  /(?<!\b(?:kein|keine|ohne|no|not)\s)\b(?:home[\s-]?office|mobiles?\s+arbeiten)\b/i;

const field = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;

/** Remote from the place, the work type fields the sources give (isRemote, workplaceType) or the title. */
function isRemote(job: MatchableJob): boolean {
  if (field(job.raw, 'isRemote') === true) return true;
  const type = field(job.raw, 'workplaceType');
  if (typeof type === 'string' && type.trim().toLowerCase() === 'remote') return true;
  return [job.title, job.location ?? ''].some((s) => REMOTE_WORD.test(s) || HOME_OFFICE.test(s));
}

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Whole-word match, case-insensitive; letters and digits (any script) count as part of a word. */
function has(haystack: string, needle: string): boolean {
  const text = haystack.toLowerCase();
  const word = needle.trim().toLowerCase();
  if (word === '') return false;
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + word.length])) return true;
  }
  return false;
}

/**
 * The hard filters of one Target, before anything else: exclusion words, blocked companies, remote
 * preference, and location with radius. Salary floor waits for a Source that reports salary.
 */
export function hardFilter(
  job: MatchableJob,
  c: ResolvedCriteria,
  places: PlaceTable,
): FilterOutcome {
  const text = [job.title, job.company, job.location].filter((s) => s !== null).join(' ');
  if (c.exclusionWords.some((w) => has(text, w))) return { pass: false, unknownLocation: false };
  const company = job.company ?? '';
  if (c.blockedCompanies.some((b) => has(company, b)))
    return { pass: false, unknownLocation: false };

  if (isRemote(job)) {
    // A remote posting has no place to measure: it passes unless remote work is refused.
    return { pass: c.remoteAllowed !== false, unknownLocation: false };
  }

  const wanted = c.locations ?? [];
  if (wanted.length === 0 || c.radiusKm === null) return { pass: true, unknownLocation: false };
  const targets = wanted.map((w) => places.resolve(w)).filter((p) => p !== null);
  const at = job.location === null ? null : places.resolve(job.location);
  if (targets.length === 0 || at === null) return { pass: true, unknownLocation: true };
  const radius = c.radiusKm;
  const near = targets.some((t) => t.key === at.key || distanceKm(t, at) <= radius);
  return { pass: near, unknownLocation: false };
}

const flatten = (v: unknown, out: string[]): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flatten(x, out));
  else if (typeof v === 'object' && v !== null) Object.values(v).forEach((x) => flatten(x, out));
  return out;
};

/**
 * Keyword score: a keyword in the title counts 3, one anywhere else in the posting counts 1, each
 * keyword once.
 */
export function prerankScore(job: MatchableJob, keywords: string[]): number {
  const title = job.title.toLowerCase();
  let rest: string | undefined;
  let score = 0;
  for (const k of new Set(keywords.map((w) => w.trim().toLowerCase()).filter((w) => w !== ''))) {
    if (title.includes(k)) score += 3;
    else {
      rest ??= flatten(job.raw, []).join(' ').toLowerCase();
      if (rest.includes(k)) score += 1;
    }
  }
  return score;
}

/**
 * The top `topN` by score, newest first on a tie. With keywords a score of 0 never passes; without
 * keywords every job ties at 0 and the newest topN pass.
 */
export function prerank<T extends { job: MatchableJob; score: number }>(
  scored: T[],
  topN: number,
  hasKeywords: boolean,
): T[] {
  return scored
    .filter((s) => !hasKeywords || s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.job.recency.getTime() - a.job.recency.getTime() ||
        a.job.id.localeCompare(b.job.id),
    )
    .slice(0, topN);
}
