import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { JobAdapter, RawJob } from './types.js';

// feki.de's Jobbörse moved to bambase.de (Nov 2026); source_type stays `feki`
// so prompts, the sources.yaml name and the n8n routing keep working.
const BASE = 'https://bambase.de';

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  stunde: 3_600_000,
  tag: 86_400_000,
  woche: 604_800_000,
  monat: 2_592_000_000,
};

/**
 * "vor 17 Stunden" / "vor einem Tag" / "vor 2 Tagen" → Date relative to `now`.
 * ponytail: listing only shows relative age (month = 30 days); the detail page
 * has the exact day, parse it there if precision ever matters.
 */
export function parseRelativeGerman(text: string, now = new Date()): Date | undefined {
  const m = /vor\s+(\d+|einer?m?)\s+(minute|stunde|tag|woche|monat)/i.exec(text);
  if (!m) return undefined;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : 1;
  return new Date(now.getTime() - n * UNIT_MS[m[2]!.toLowerCase()]!);
}

/** Parse the bambase.de /jobs listing HTML into RawJobs (pure, no network). */
export function parseFekiHtml(html: string, now = new Date()): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  $('a[href^="/job/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href')!;
    // /job/<slug> → slug; skips /job/new and anything without a card title
    const slug = /^\/job\/([^/?#]+)$/.exec(href)?.[1];
    const title = $el.find('h3').first().text().trim();
    if (!slug || slug === 'new' || !title) return;

    // meta row: [company span (has .truncate)] [location span] [hours span]
    const meta = $el.find('h3').next('div').children('span');
    const company = meta.find('.truncate').first().text().trim() || undefined;
    const location =
      meta
        .filter((_, s) => $(s).find('.truncate').length === 0)
        .first()
        .text()
        .trim() || undefined;
    const type = $el.find('.badge').first().text().trim() || undefined;
    const age = $el.find('.text-xs').first().text().trim();

    jobs.push({
      externalId: slug,
      title,
      company,
      location,
      postedAt: parseRelativeGerman(age, now),
      applyUrl: new URL(href, BASE).toString(),
      raw: { html: $.html($el), href, title, company, location, type, age },
    });
  });

  return jobs;
}

async function get(url: string): Promise<string> {
  const res = await request(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (job-portal scraper)' },
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`bambase returned HTTP ${res.statusCode}`);
  }
  return res.body.text();
}

export const fekiAdapter: JobAdapter = {
  sourceType: 'feki',
  async fetch(url: string): Promise<RawJob[]> {
    return parseFekiHtml(await get(url));
  },
  async fetchDescription(job: { applyUrl: string }): Promise<string> {
    const $ = cheerio.load(await get(job.applyUrl));
    return $('main .prose').first().text().replace(/\s+/g, ' ').trim();
  },
};
