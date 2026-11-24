import type { FetchResult, NormalizedPosting, Source } from '../source';

export const ATS_IDS = ['greenhouse', 'lever', 'ashby'] as const;
export type Ats = (typeof ATS_IDS)[number];

/** One company board on an ATS, as the Board directory lists it. */
export interface BoardRef {
  token: string;
  name: string;
  /** Lever only: "eu" for boards on the EU host. */
  host?: string | null;
}

// Fixed hosts: nothing from configuration, the directory or a page decides where requests go.
const GREENHOUSE_URL = 'https://boards-api.greenhouse.io/v1/boards';
const LEVER_URL = 'https://api.lever.co/v0/postings';
const LEVER_EU_URL = 'https://api.eu.lever.co/v0/postings';
const ASHBY_URL = 'https://api.ashbyhq.com/posting-api/job-board';
const REQUEST_TIMEOUT_MS = 25_000;
const LEVER_PAGE_LIMIT = 100;
const LEVER_MAX_PAGES = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
const date = (v: unknown): Date | undefined => {
  const s = str(v) ?? (typeof v === 'number' ? new Date(v).toISOString() : undefined);
  const d = s === undefined ? undefined : new Date(s);
  return d !== undefined && !Number.isNaN(d.getTime()) ? d : undefined;
};

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (job-portal)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json();
}

function jobs(body: unknown, key?: string): Obj[] {
  const list = key === undefined ? body : isObj(body) ? body[key] : undefined;
  if (!Array.isArray(list)) throw new Error('unexpected response shape');
  return list.filter(isObj);
}

/** Greenhouse: one response holds every job, with content. */
async function greenhouse(board: BoardRef, fetchImpl: typeof fetch): Promise<NormalizedPosting[]> {
  const body = await getJson(
    fetchImpl,
    `${GREENHOUSE_URL}/${encodeURIComponent(board.token)}/jobs?content=true`,
  );
  const out: NormalizedPosting[] = [];
  for (const j of jobs(body, 'jobs')) {
    const id = j['id'];
    const url = str(j['absolute_url']);
    const title = str(j['title']);
    if (
      (typeof id !== 'number' && typeof id !== 'string') ||
      url === undefined ||
      title === undefined
    )
      continue;
    out.push({
      sourcePostingId: `${board.token}/${String(id)}`,
      title,
      company: str(j['company_name']) ?? board.name,
      location: isObj(j['location']) ? str(j['location']['name']) : undefined,
      postedAt: date(j['first_published']) ?? date(j['updated_at']),
      url,
      raw: j,
    });
  }
  return out;
}

/** Lever: pages by skip and limit with no total, so page until a short page. */
async function lever(board: BoardRef, fetchImpl: typeof fetch): Promise<NormalizedPosting[]> {
  const base = board.host === 'eu' ? LEVER_EU_URL : LEVER_URL;
  const out: NormalizedPosting[] = [];
  let previousFirst: unknown;
  for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
    const url = `${base}/${encodeURIComponent(board.token)}?mode=json&skip=${String(page * LEVER_PAGE_LIMIT)}&limit=${String(LEVER_PAGE_LIMIT)}`;
    const batch = jobs(await getJson(fetchImpl, url));
    if (batch[0] !== undefined && batch[0]['id'] === previousFirst) break; // board ignores skip
    previousFirst = batch[0]?.['id'];
    for (const j of batch) {
      const id = str(j['id']);
      const link = str(j['hostedUrl']);
      const title = str(j['text']);
      if (id === undefined || link === undefined || title === undefined) continue;
      const categories = isObj(j['categories']) ? j['categories'] : {};
      const all = Array.isArray(categories['allLocations'])
        ? categories['allLocations'].filter((l): l is string => typeof l === 'string')
        : [];
      const place = all.length > 0 ? all : [str(categories['location'])];
      const location = [...place, str(j['country'])].filter((l) => l !== undefined).join(', ');
      out.push({
        sourcePostingId: `${board.token}/${id}`,
        title,
        company: board.name,
        location: location === '' ? undefined : location,
        postedAt: date(j['createdAt']),
        url: link,
        raw: j,
      });
    }
    if (batch.length < LEVER_PAGE_LIMIT) break;
  }
  return out;
}

/** Ashby: one response holds the whole board; unlisted jobs are not public. */
async function ashby(board: BoardRef, fetchImpl: typeof fetch): Promise<NormalizedPosting[]> {
  const body = await getJson(fetchImpl, `${ASHBY_URL}/${encodeURIComponent(board.token)}`);
  const out: NormalizedPosting[] = [];
  for (const j of jobs(body, 'jobs')) {
    const id = str(j['id']);
    const url = str(j['jobUrl']);
    const title = str(j['title']);
    if (id === undefined || url === undefined || title === undefined || j['isListed'] === false)
      continue;
    const secondary = Array.isArray(j['secondaryLocations'])
      ? j['secondaryLocations'].filter(isObj).map((s) => str(s['location']))
      : [];
    const location = [
      ...new Set([str(j['location']), ...secondary].filter((l) => l !== undefined)),
    ];
    out.push({
      sourcePostingId: `${board.token}/${id}`,
      title,
      company: board.name,
      location: location.length > 0 ? location.join(', ') : undefined,
      postedAt: date(j['publishedAt']),
      url,
      raw: j,
    });
  }
  return out;
}

const adapters: Record<
  Ats,
  (board: BoardRef, fetchImpl: typeof fetch) => Promise<NormalizedPosting[]>
> = { greenhouse, lever, ashby };

/** Fetches one board's postings; throws when the board answers with an error or garbage. */
export function fetchBoardPostings(
  ats: Ats,
  board: BoardRef,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedPosting[]> {
  return adapters[ats](board, fetchImpl);
}

export interface AtsSourceOptions {
  /** The boards to fetch: the Board directory's marked boards. Read on every run. */
  listBoards: () => Promise<BoardRef[]>;
  /** Wrap with createRateLimitedFetch to keep requests per ATS host under the configured rate. */
  fetch?: typeof fetch;
}

/**
 * A Source over every listed board of one ATS. A failing board adds one line to the errors (the
 * run ends "completed with errors") and the other boards still run.
 * ponytail: boards are fetched one after another; the rate limit is the pace, not concurrency.
 */
export function createAtsSource(
  ats: Ats,
  { listBoards, fetch: fetchImpl = fetch }: AtsSourceOptions,
): Source {
  return {
    id: ats,
    async fetch(): Promise<FetchResult> {
      const postings: NormalizedPosting[] = [];
      const errors: string[] = [];
      for (const board of await listBoards()) {
        try {
          postings.push(...(await fetchBoardPostings(ats, board, fetchImpl)));
        } catch (err) {
          errors.push(
            `${ats} board ${board.token}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { postings, errors };
    },
  };
}
