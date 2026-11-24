import { z } from 'zod';
import type { FetchResult, NormalizedPosting, Source } from '../source';

export const BUNDESAGENTUR = 'bundesagentur';

/** Builds the API query string of one search from the parameters Matching hands out. */
export const bundesagenturQuery = (q: { was?: string; wo?: string; umkreis?: number }): string => {
  const p = new URLSearchParams();
  if (q.was !== undefined) p.set('was', q.was);
  if (q.wo !== undefined) p.set('wo', q.wo);
  if (q.umkreis !== undefined) p.set('umkreis', String(q.umkreis));
  return p.toString();
};

const API_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const DETAIL_API_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails';
const API_KEY = 'jobboerse-jobsuche'; // public key documented for this endpoint

// ponytail: a single page of results, as on main; add paging with a page cap when one query needs more.
const REQUEST_TIMEOUT_MS = 30_000;

// Only these query parameters reach the API.
const ALLOWED_PARAMS = ['was', 'wo', 'umkreis', 'arbeitszeit', 'angebotsart', 'sort'];

const resultSchema = z.looseObject({
  referenznummer: z.string().optional(),
  stellenangebotsTitel: z.string().optional(),
  firma: z.string().optional(),
  stellenlokationen: z
    .array(z.looseObject({ adresse: z.looseObject({ ort: z.string().optional() }).optional() }))
    .optional(),
  datumErsteVeroeffentlichung: z.string().optional(),
  aenderungsdatum: z.string().optional(),
});
type Result = z.infer<typeof resultSchema>;

// Each result is validated on its own, so one odd entry does not discard the page.
const responseSchema = z.object({ ergebnisliste: z.array(z.unknown()).optional() });

export interface BundesagenturOptions {
  /** One fixed query string of API parameters, for example `wo=Musterstadt&umkreis=25`. */
  query?: string;
  /** The query strings to run, read on every fetch (the active Targets' searches). Wins over `query`. */
  queries?: () => Promise<string[]>;
  fetch?: typeof fetch;
}

function normalize(r: Result): NormalizedPosting | null {
  const id = r.referenznummer;
  if (id === undefined || id === '') return null;
  const posted = r.datumErsteVeroeffentlichung ?? r.aenderungsdatum;
  return {
    sourcePostingId: id,
    title: r.stellenangebotsTitel ?? '',
    company: r.firma,
    location: r.stellenlokationen?.[0]?.adresse?.ort,
    postedAt: posted === undefined ? undefined : new Date(posted),
    url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(id)}`,
    raw: r,
  };
}

export function createBundesagenturSource({
  query = '',
  queries,
  fetch: fetchImpl = fetch,
}: BundesagenturOptions): Source {
  const get = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`bundesagentur API returned HTTP ${String(res.status)}`);
    return res.json();
  };

  return {
    id: BUNDESAGENTUR,
    async fetch(): Promise<FetchResult> {
      const postings = new Map<string, NormalizedPosting>();
      const errors: string[] = [];
      const failures: unknown[] = [];
      // ponytail: one request per keyword x location of every active Target, no cap and sequential;
      // upgrade: cap the count or run a few in parallel if Targets grow past a few dozen searches.
      const runs = queries ? await queries() : [query];
      for (const q of runs) {
        try {
          const source = new URLSearchParams(q);
          const params = new URLSearchParams();
          for (const key of ALLOWED_PARAMS) {
            const value = source.get(key);
            if (value !== null && value !== '') params.set(key, value);
          }
          const body = responseSchema.parse(await get(`${API_URL}?${params.toString()}`));
          for (const entry of body.ergebnisliste ?? []) {
            const parsed = resultSchema.safeParse(entry);
            const posting = parsed.success ? normalize(parsed.data) : null;
            if (posting) postings.set(posting.sourcePostingId, posting);
            else
              errors.push(
                `result without referenznummer: ${parsed.success ? (parsed.data.stellenangebotsTitel ?? '') : 'unreadable'}`,
              );
          }
        } catch (err) {
          failures.push(err);
          errors.push(`search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Every search failing is a failed run; some failing is a run with errors.
      if (runs.length > 0 && failures.length === runs.length) throw failures[0];
      return { postings: [...postings.values()], errors };
    },
    async fetchDescription({ sourcePostingId }): Promise<string> {
      const id = Buffer.from(sourcePostingId).toString('base64');
      const body = z
        .object({ stellenangebotsBeschreibung: z.string().optional() })
        .parse(await get(`${DETAIL_API_URL}/${id}`));
      return body.stellenangebotsBeschreibung ?? '';
    },
  };
}
