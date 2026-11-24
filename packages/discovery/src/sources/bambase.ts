import * as cheerio from 'cheerio';
import type { FetchResult, NormalizedPosting, Source } from '../source';

export const BAMBASE = 'bambase';

// Fixed host: nothing from configuration or from the page decides where requests go.
const BASE = 'https://bambase.de';
const REQUEST_TIMEOUT_MS = 30_000;

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  stunde: 3_600_000,
  tag: 86_400_000,
  woche: 604_800_000,
  monat: 2_592_000_000,
};

/**
 * "vor 17 Stunden" / "vor einem Tag" / "vor 2 Tagen" to a Date relative to `now`.
 * ponytail: the listing only shows a relative age (month = 30 days); the detail page has the exact day.
 */
export function parseRelativeGerman(text: string, now: Date): Date | undefined {
  const m = /vor\s+(\d+|einer?m?)\s+(minute|stunde|tag|woche|monat)/i.exec(text);
  const count = m?.[1];
  const unit = m?.[2];
  if (count === undefined || unit === undefined) return undefined;
  const n = /^\d+$/.test(count) ? Number(count) : 1;
  const ms = UNIT_MS[unit.toLowerCase()];
  return ms === undefined ? undefined : new Date(now.getTime() - n * ms);
}

export interface BambaseOptions {
  fetch?: typeof fetch;
  /** The clock the relative ages are measured from. */
  now?: () => Date;
}

export function createBambaseSource({
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: BambaseOptions = {}): Source {
  const get = async (path: string): Promise<string> => {
    const res = await fetchImpl(`${BASE}${path}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (job-portal)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`bambase returned HTTP ${String(res.status)}`);
    return res.text();
  };

  return {
    id: BAMBASE,
    async fetch(): Promise<FetchResult> {
      const $ = cheerio.load(await get('/jobs'));
      const at = now();
      const postings: NormalizedPosting[] = [];
      const errors: string[] = [];

      $('a[href^="/job/"]').each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href') ?? '';
        // /job/<slug> gives the slug; /job/new is the post-a-job link, not a listing.
        const slug = /^\/job\/([^/?#]+)$/.exec(href)?.[1];
        if (slug === undefined || slug === 'new') return;
        const title = $el.find('h3').first().text().trim();
        if (title === '') {
          errors.push(`listing without a title: ${slug}`);
          return;
        }
        // meta row: [company span (has .truncate)] [location span] [hours span]
        const meta = $el.find('h3').next('div').children('span');
        const company = meta.find('.truncate').first().text().trim() || undefined;
        const location =
          meta
            .filter((_i, s) => $(s).find('.truncate').length === 0)
            .first()
            .text()
            .trim() || undefined;
        const type = $el.find('.badge').first().text().trim() || undefined;
        const age = $el.find('.text-xs').first().text().trim();
        postings.push({
          sourcePostingId: slug,
          title,
          company,
          location,
          postedAt: parseRelativeGerman(age, at),
          url: new URL(href, BASE).toString(),
          raw: { html: $.html($el), href, title, company, location, type, age },
        });
      });
      return { postings, errors };
    },
    async fetchDescription({ sourcePostingId }): Promise<string> {
      const $ = cheerio.load(await get(`/job/${encodeURIComponent(sourcePostingId)}`));
      return $('main .prose').first().text().replace(/\s+/g, ' ').trim();
    },
  };
}
