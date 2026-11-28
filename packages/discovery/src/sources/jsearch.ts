import { z } from 'zod';
import type { FetchResult, NormalizedPosting, Source } from '../source';

export const JSEARCH = 'jsearch';

const API_URLS = {
  jsearch: 'https://api.openwebninja.com/jsearch/search-v2',
  linkedin: 'https://api.openwebninja.com/realtime-linkedin-data/search',
  indeed: 'https://api.openwebninja.com/realtime-indeed-data/search',
} as const;
const REQUEST_TIMEOUT_MS = 30_000;
export type ApiId = keyof typeof API_URLS;
/** The slots a search rotates over: its own API's slots plus the JSearch ones. The pool `jsearch` is every other publisher. */
export type SlotPool = ApiId;

/** The pool of a search by its publisher: linkedin and indeed have a dedicated API, any other publisher or none does not. */
export function poolOf(publisher: string | null): SlotPool {
  const p = publisher?.toLowerCase();
  return p === 'linkedin' || p === 'indeed' ? p : 'jsearch';
}

/** One request sent, as the request log keeps it. Never carries the key. */
export interface RequestLogEntry {
  api: ApiId;
  /** The key position, counted from 1. */
  keyPosition: number;
  publisher: string | null;
  /** The query text sent. */
  query: string;
  /** The HTTP status, null when no answer came. */
  status: number | null;
  /** A fixed reason when the request failed without an HTTP status or the body was unusable, else null. */
  failure: string | null;
  jobsReturned: number;
}

/** Where the Source records every request. The round-robin position of each pool is read back from it. */
export interface RequestLog {
  record(entry: RequestLogEntry): Promise<void>;
  /** The slot the newest request of this pool used, null when the pool has none yet. */
  lastSlot(pool: SlotPool): Promise<{ api: ApiId; keyPosition: number } | null>;
}

/** A key that gets one of these answers is out of quota or refused, so the search moves to the next slot. */
const KEY_REFUSED = new Set([429, 401, 403]);

/** One text search; the same shape Matching's `textQueries` hands out (Discovery never imports Matching). */
export interface JsearchQuery {
  keyword?: string;
  location?: string;
  radiusKm?: number;
}

export interface JsearchOptions {
  /** At least one. Secrets: named by position in every message, never written out. One key serves all three APIs. */
  apiKeys: string[];
  requestLog: RequestLog;
  /** One search per query and publisher with ` via <publisher>` appended. Empty means one search without a publisher. */
  publishers: string[];
  /** Two-letter country code: JSearch and Indeed take it as is, LinkedIn gets the country name in its location. */
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

// An unparseable date would make the insert throw and fail the run on every poll, so it counts as missing.
const dated = (v: string | number | null | undefined): Date | undefined => {
  const d = v === null || v === undefined ? undefined : new Date(v);
  return d === undefined || Number.isNaN(d.getTime()) ? undefined : d;
};

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
  const postedAt =
    dated(filled(r.job_posted_at_datetime_utc)) ??
    dated(r.job_posted_at_timestamp == null ? undefined : r.job_posted_at_timestamp * 1000);
  return {
    sourcePostingId: id,
    title: r.job_title ?? '',
    company: filled(r.employer_name),
    // "Musterstadt  •  über LinkedIn": the part before the first bullet is the place.
    location: filled(r.job_city) ?? filled(r.job_location?.split('•')[0]),
    postedAt,
    url,
    publisher,
    raw: r,
  };
}

// The dedicated APIs answer `data` as the list itself, JSearch as `data.jobs`.
const dedicatedResultSchema = z.looseObject({
  job_uid: optionalText,
  job_title: optionalText,
  employer_name: optionalText,
  job_location: optionalText,
  job_city: optionalText,
  job_posted_at_datetime_utc: optionalText,
  job_posted_at_timestamp: z.number().nullish(),
});
const dedicatedResponseSchema = z.object({ data: z.array(z.unknown()) });

function normalizeDedicated(
  api: 'linkedin' | 'indeed',
  country: string,
  r: z.infer<typeof dedicatedResultSchema>,
): NormalizedPosting | string {
  const uid = filled(r.job_uid);
  if (uid === undefined) return `result without job_uid: ${r.job_title ?? ''}`;
  const host = country === 'us' ? 'www' : country;
  return {
    sourcePostingId: `${api}:${uid}`,
    title: r.job_title ?? '',
    company: filled(r.employer_name),
    location: filled(r.job_city) ?? filled(r.job_location?.split('•')[0]),
    postedAt:
      dated(filled(r.job_posted_at_datetime_utc)) ??
      dated(r.job_posted_at_timestamp == null ? undefined : r.job_posted_at_timestamp * 1000),
    // The same link a person would open, so the job also merges with the JSearch posting of it (ADR agent 0024).
    url:
      api === 'linkedin'
        ? `https://www.linkedin.com/jobs/view/${uid}`
        : `https://${host}.indeed.com/viewjob?jk=${uid}`,
    publisher: api === 'linkedin' ? 'LinkedIn' : 'Indeed',
    raw: r,
  };
}

interface Slot {
  api: ApiId;
  keyPosition: number;
}
const slotName = (s: Slot): string => `${s.api}:${String(s.keyPosition)}`;

/** Every slot of the pool was refused on one search. The run stops and the Pipeline alerts `source:jsearch`. */
class KeysExhausted extends Error {
  override name = 'KeysExhausted';
}

class HttpFailure extends Error {
  override name = 'HttpFailure';
  /** Status 0 means no answer came, and `reason` then names why. */
  constructor(
    readonly status: number,
    reason?: string,
  ) {
    super(reason ?? `HTTP ${String(status)}`);
  }
}

/** The request log could not be read or written: a database fault, not a failed search. */
class LogFailure extends Error {
  override name = 'LogFailure';
}

export interface JsearchStats {
  /** Requests sent since the Source was built, retries on another slot included. */
  requests: number;
  /** Every slot of the APIs in use with its request count. The key position counts from 1. */
  slots: { api: ApiId; keyPosition: number; requests: number }[];
}

interface Search {
  keyword?: string;
  location?: string;
  radiusKm?: number;
  publisher: string | null;
  /** The JSearch query text. */
  text: string;
}

export function createJsearchSource({
  apiKeys,
  requestLog,
  publishers,
  country,
  language = null,
  queries,
  fetch: fetchImpl = fetch,
}: JsearchOptions): Source & { stats: () => JsearchStats } {
  const countryName =
    new Intl.DisplayNames(['en'], { type: 'region' }).of(country.toUpperCase()) ?? country;
  const dedicated = [...new Set(publishers.map((p) => poolOf(p)))].filter((p) => p !== 'jsearch');
  const keyPositions = apiKeys.map((_, i) => i + 1);
  const slotsOf = (api: ApiId): Slot[] => keyPositions.map((keyPosition) => ({ api, keyPosition }));
  /** The slots a search of this pool rotates over: JSearch key 1 to n, then the pool's own API key 1 to n. */
  const poolSlots = (pool: SlotPool): Slot[] =>
    pool === 'jsearch' ? slotsOf('jsearch') : [...slotsOf('jsearch'), ...slotsOf(pool)];
  const counts = new Map<string, number>();
  let requests = 0;
  /** Slots refused during this fetch, shared by every pool: a refused key is refused for its whole API. */
  let unusable = new Set<string>();

  const params = (s: Search, api: ApiId): URLSearchParams => {
    const p = new URLSearchParams();
    if (api === 'jsearch') {
      p.set('query', s.text);
      p.set('country', country);
      p.set('date_posted', 'week');
      if (language !== null) p.set('language', language);
      if (s.location !== undefined && s.radiusKm !== undefined) p.set('radius', String(s.radiusKm));
      return p;
    }
    p.set('query', s.keyword ?? 'jobs');
    if (api === 'linkedin') {
      // LinkedIn has no country parameter and a radius needs a geo id we do not have.
      p.set('location', s.location === undefined ? countryName : `${s.location}, ${countryName}`);
    } else {
      if (s.location !== undefined) p.set('location', s.location);
      p.set('country', country);
      if (language !== null) p.set('language', language);
      if (s.location !== undefined && s.radiusKm !== undefined) p.set('radius', String(s.radiusKm));
    }
    p.set('date_posted', 'week');
    return p;
  };

  /** Sends one request on one slot and logs it. Returns the list of results or throws. */
  const send = async (s: Search, slot: Slot): Promise<unknown[]> => {
    const query = params(s, slot.api);
    requests += 1;
    counts.set(slotName(slot), (counts.get(slotName(slot)) ?? 0) + 1);
    const entry = (over: Partial<RequestLogEntry>): RequestLogEntry => ({
      api: slot.api,
      keyPosition: slot.keyPosition,
      publisher: s.publisher,
      query: query.get('query') ?? '',
      status: null,
      failure: null,
      jobsReturned: 0,
      ...over,
    });
    const log = async (e: RequestLogEntry): Promise<void> => {
      try {
        await requestLog.record(e);
      } catch (err) {
        throw new LogFailure(err instanceof Error ? err.message : 'request log write failed');
      }
    };
    let res: Response;
    try {
      res = await fetchImpl(`${API_URLS[slot.api]}?${query.toString()}`, {
        headers: { 'x-api-key': apiKeys[slot.keyPosition - 1] ?? '' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const failure =
        err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error';
      await log(entry({ failure }));
      throw new HttpFailure(0, failure);
    }
    if (!res.ok) {
      await log(entry({ status: res.status }));
      throw new HttpFailure(res.status);
    }
    try {
      const body: unknown = await res.json();
      const list =
        slot.api === 'jsearch'
          ? responseSchema.parse(body).data.jobs
          : dedicatedResponseSchema.parse(body).data;
      await log(entry({ status: res.status, jobsReturned: list.length }));
      return list;
    } catch (err) {
      if (err instanceof LogFailure) throw err;
      await log(entry({ status: res.status, failure: 'unusable response' }));
      throw new HttpFailure(res.status, 'unusable response');
    }
  };

  /** Runs one search on the next usable slot of its pool, moving on after each refusal. */
  const run = async (s: Search): Promise<{ api: ApiId; list: unknown[] }> => {
    const pool = poolOf(s.publisher);
    const slots = poolSlots(pool);
    let last: { api: ApiId; keyPosition: number } | null;
    try {
      last = await requestLog.lastSlot(pool);
    } catch (err) {
      throw new LogFailure(err instanceof Error ? err.message : 'request log read failed');
    }
    let at =
      last === null
        ? -1
        : slots.findIndex((x) => x.api === last.api && x.keyPosition === last.keyPosition);
    for (;;) {
      let next: Slot | undefined;
      for (let step = 1; step <= slots.length && next === undefined; step += 1) {
        const candidate = slots[(at + step + slots.length) % slots.length];
        if (candidate !== undefined && !unusable.has(slotName(candidate))) next = candidate;
      }
      if (next === undefined) throw new KeysExhausted('every API key was refused');
      try {
        return { api: next.api, list: await send(s, next) };
      } catch (err) {
        if (!(err instanceof HttpFailure && KEY_REFUSED.has(err.status))) throw err;
        unusable.add(slotName(next));
        at = slots.findIndex((x) => x.api === next.api && x.keyPosition === next.keyPosition);
      }
    }
  };

  return {
    id: JSEARCH,
    stats: () => ({
      requests,
      slots: ['jsearch' as const, ...dedicated].flatMap((api) =>
        slotsOf(api).map((s) => ({ ...s, requests: counts.get(slotName(s)) ?? 0 })),
      ),
    }),
    async fetch(): Promise<FetchResult> {
      unusable = new Set();
      const postings = new Map<string, NormalizedPosting>();
      const errors: string[] = [];
      const failures: string[] = [];
      // ponytail: one page per query and publisher, sequential, with the queries capped by Matching.
      const searches: Search[] = (await queries()).flatMap((q) =>
        (publishers.length > 0 ? publishers : [null]).map((publisher) => ({
          ...q,
          publisher,
          text: `${queryText(q)}${publisher === null ? '' : ` via ${publisher}`}`,
        })),
      );
      for (const [i, search] of searches.entries()) {
        try {
          const { api, list } = await run(search);
          for (const entry of list) {
            let posting: NormalizedPosting | string;
            if (api === 'jsearch') {
              const parsed = resultSchema.safeParse(entry);
              posting = parsed.success ? normalize(parsed.data) : 'result in an unexpected shape';
            } else {
              const parsed = dedicatedResultSchema.safeParse(entry);
              posting = parsed.success
                ? normalizeDedicated(api, country.toLowerCase(), parsed.data)
                : 'result in an unexpected shape';
            }
            if (typeof posting === 'string') errors.push(posting);
            else postings.set(posting.sourcePostingId, posting);
          }
        } catch (err) {
          if (err instanceof KeysExhausted || err instanceof LogFailure) throw err;
          // The line names the search by position and gives a fixed reason: never the query text, never a key.
          const line = `search ${String(i + 1)} failed: ${err instanceof HttpFailure ? err.message : 'network error'}`;
          failures.push(line);
          errors.push(line);
        }
      }
      // Every search failing is a failed run, some failing is a run with errors.
      if (searches.length > 0 && failures.length === searches.length) throw new Error(failures[0]);
      return { postings: [...postings.values()], errors };
    },
  };
}
