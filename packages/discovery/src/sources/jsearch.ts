import { z } from 'zod';
import type { FetchResult, NormalizedPosting, Source } from '../source';

export const JSEARCH = 'jsearch';

const API_URL = 'https://api.openwebninja.com/jsearch/search-v2';
const REQUEST_TIMEOUT_MS = 30_000;
/** A key that gets one of these answers is out of quota or refused; the request moves to the next key. */
const KEY_REFUSED = new Set([429, 401, 403]);

/** One text search; the same shape Matching's `textQueries` hands out (Discovery never imports Matching). */
export interface JsearchQuery {
  keyword?: string;
  location?: string;
  radiusKm?: number;
}

export interface JsearchOptions {
  /** At least one. Secrets: named by position in every message, never written out. */
  apiKeys: string[];
  /** One search per query and publisher with ` via <publisher>` appended. Empty means one search without a publisher. */
  publishers: string[];
  country: string;
  language?: string | null;
  /** The searches to run, read on every fetch (the active Targets' keyword and location pairs). */
  queries: () => Promise<JsearchQuery[]>;
  fetch?: typeof fetch;
}

const optionalText = z.string().nullish();
const resultSchema = z.looseObject({
  job_id: optionalText,
  job_title: optionalText,
  employer_name: optionalText,
  job_publisher: optionalText,
  job_apply_link: optionalText,
  apply_options: z
    .array(z.looseObject({ publisher: optionalText, apply_link: optionalText }))
    .nullish(),
  job_google_link: optionalText,
  job_location: optionalText,
  job_city: optionalText,
  job_posted_at_datetime_utc: optionalText,
  job_posted_at_timestamp: z.number().nullish(),
});
type Result = z.infer<typeof resultSchema>;

// Each result is validated on its own, so one odd entry does not discard the page.
const responseSchema = z.object({ data: z.object({ jobs: z.array(z.unknown()) }) });

const filled = (v: string | null | undefined): string | undefined =>
  v === null || v === undefined || v.trim() === '' ? undefined : v.trim();

/** The text of one search; Google for Jobs reads it like a person's query. */
function queryText({ keyword, location }: JsearchQuery): string {
  if (keyword !== undefined && location !== undefined) return `${keyword} in ${location}`;
  return keyword ?? `jobs in ${location ?? ''}`;
}

function normalize(r: Result): NormalizedPosting | string {
  const id = filled(r.job_id);
  if (id === undefined) return `result without job_id: ${r.job_title ?? ''}`;
  const publisher = filled(r.job_publisher);
  const url =
    filled(r.apply_options?.find((o) => filled(o.publisher) === publisher)?.apply_link) ??
    filled(r.job_apply_link) ??
    filled(r.job_google_link);
  if (url === undefined) return `result without a link: ${r.job_title ?? ''}`;
  const posted =
    filled(r.job_posted_at_datetime_utc) ??
    (r.job_posted_at_timestamp == null ? undefined : r.job_posted_at_timestamp * 1000);
  return {
    sourcePostingId: id,
    title: r.job_title ?? '',
    company: filled(r.employer_name),
    // "Musterstadt  •  über LinkedIn": the part before the first bullet is the place.
    location: filled(r.job_city) ?? filled(r.job_location?.split('•')[0]),
    postedAt: posted === undefined ? undefined : new Date(posted),
    url,
    publisher,
    raw: r,
  };
}

/** Every key was refused on one request; the run stops and the Pipeline alerts `source:jsearch`. */
class KeysExhausted extends Error {
  override name = 'KeysExhausted';
}

class HttpFailure extends Error {
  override name = 'HttpFailure';
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}

export interface JsearchStats {
  /** Requests sent since the Source was built, retries on another key included. */
  requests: number;
  /** The key the next request starts on, counted from 1. */
  keyPosition: number;
}

export function createJsearchSource({
  apiKeys,
  publishers,
  country,
  language = null,
  queries,
  fetch: fetchImpl = fetch,
}: JsearchOptions): Source & { stats: () => JsearchStats } {
  // The current key survives between runs until the process restarts. The unusable set is per fetch.
  let current = 0;
  let unusable = new Set<number>();
  let requests = 0;

  const scrub = (text: string): string => apiKeys.reduce((t, k) => t.split(k).join('[key]'), text);

  /** Sends one request with the current key, moving to the next key on a refusal. */
  const get = async (params: URLSearchParams): Promise<unknown> => {
    for (;;) {
      requests += 1;
      const res = await fetchImpl(`${API_URL}?${params.toString()}`, {
        headers: { 'x-api-key': apiKeys[current] ?? '' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res.json();
      if (!KEY_REFUSED.has(res.status)) throw new HttpFailure(res.status);
      unusable.add(current);
      const next = apiKeys.findIndex((_, i) => !unusable.has(i) && i > current);
      const wrapped = apiKeys.findIndex((_, i) => !unusable.has(i));
      if (next === -1 && wrapped === -1) throw new KeysExhausted('every API key was refused');
      current = next === -1 ? wrapped : next;
    }
  };

  return {
    id: JSEARCH,
    stats: () => ({ requests, keyPosition: current + 1 }),
    async fetch(): Promise<FetchResult> {
      unusable = new Set();
      const postings = new Map<string, NormalizedPosting>();
      const errors: string[] = [];
      const failures: string[] = [];
      // ponytail: one page per query and publisher, sequential, with the queries capped by Matching.
      const runs = (await queries()).flatMap((q) =>
        (publishers.length > 0 ? publishers : [null]).map((publisher) => ({
          text: `${queryText(q)}${publisher === null ? '' : ` via ${publisher}`}`,
          radiusKm: q.location === undefined ? undefined : q.radiusKm,
        })),
      );
      for (const [i, run] of runs.entries()) {
        try {
          const params = new URLSearchParams({ query: run.text, country, date_posted: 'week' });
          if (language !== null) params.set('language', language);
          if (run.radiusKm !== undefined) params.set('radius', String(run.radiusKm));
          const body = responseSchema.parse(await get(params));
          for (const entry of body.data.jobs) {
            const parsed = resultSchema.safeParse(entry);
            const posting = parsed.success
              ? normalize(parsed.data)
              : 'result in an unexpected shape';
            if (typeof posting === 'string') errors.push(posting);
            else postings.set(posting.sourcePostingId, posting);
          }
        } catch (err) {
          if (err instanceof KeysExhausted) throw err;
          // The line names the search by position, never by its text, and never carries a key.
          const reason =
            err instanceof HttpFailure
              ? err.message
              : err instanceof z.ZodError
                ? 'unusable response'
                : scrub(err instanceof Error ? err.message : String(err));
          const line = `search ${String(i + 1)} failed: ${reason}`;
          failures.push(line);
          errors.push(line);
        }
      }
      // Every search failing is a failed run, some failing is a run with errors.
      if (runs.length > 0 && failures.length === runs.length) throw new Error(failures[0]);
      return { postings: [...postings.values()], errors };
    },
  };
}
