import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { JobAdapter, RawJob } from './types.js';

const BASE = 'https://www.feki.de';

/** "08.07.2026 um 18:20 Uhr" → Date, or undefined if unparseable. */
function parseGermanDate(text: string): Date | undefined {
  const m = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+um\s+(\d{2}):(\d{2}))?/.exec(text);
  if (!m) return undefined;
  const [, d, mo, y, h = '0', min = '0'] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min));
}

/** Parse the feki jobboerse listing HTML into RawJobs (pure — no network). */
export function parseFekiHtml(html: string): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  $('.feki_jobboerse_job').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a[href*="/jobboerse/details/"]').attr('href');
    if (!href) return; // no detail link → no stable id, skip

    // /jobboerse/details/38526-Fahrradkurier... → "38526"
    const idMatch = /\/jobboerse\/details\/(\d+)-/.exec(href);
    if (!idMatch) return;
    const externalId = idMatch[1]!;

    const title = $el.find('h4').first().text().trim();

    // "<strong>Bei</strong> Labor Becker MVZ eGbR  in Bamberg <br/>"
    // The text node between the "Bei" strong and the next <br> holds both.
    const beiStrong = $el
      .find('strong')
      .filter((_, s) => $(s).text().trim() === 'Bei')
      .first();
    const beiText = (beiStrong[0]?.nextSibling as { data?: string } | undefined)?.data ?? '';
    let company: string | undefined;
    let location: string | undefined;
    const trimmed = beiText.trim();
    if (trimmed) {
      // ponytail: split on the LAST " in " — company names may contain " in ",
      // location is the trailing token. Upgrade to detail-page parse if this
      // misclassifies real listings.
      const idx = trimmed.lastIndexOf(' in ');
      if (idx >= 0) {
        company = trimmed.slice(0, idx).trim().replace(/,\s*$/, '');
        location = trimmed.slice(idx + 4).trim();
      } else {
        company = trimmed;
      }
    }

    const postedAt = parseGermanDate($el.text());

    jobs.push({
      externalId,
      title,
      company: company || undefined,
      location: location || undefined,
      postedAt,
      applyUrl: new URL(href, BASE).toString(),
      description: $el.text().replace(/\s+/g, ' ').trim(),
      raw: { html: $.html($el), href, title, company, location },
    });
  });

  return jobs;
}

export const fekiAdapter: JobAdapter = {
  sourceType: 'feki',
  async fetch(url: string): Promise<RawJob[]> {
    const res = await request(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (job-portal scraper)' },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`feki returned HTTP ${res.statusCode}`);
    }
    return parseFekiHtml(await res.body.text());
  },
};
