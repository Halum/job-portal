import { siteJobId } from './site-job';

/** Dedupe keys. Two Postings of one job get the same key; a null key never matches anything. */

const LEGAL_TOKENS = new Set([
  'gmbh',
  'mbh',
  'ag',
  'se',
  'kg',
  'kgaa',
  'ohg',
  'gbr',
  'ug',
  'haftungsbeschrankt',
  'ev',
  'co',
  'und',
  'inc',
  'ltd',
  'llc',
]);
const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|mc_.*|ref|referrer|trk|trkinfo)$/i;

// "m/w/d" and its variants when not in brackets (brackets are removed before this runs).
const GENDER_MARKER = /\b[mwdfx]\s*\/\s*[mwdfx]\s*\/\s*[mwdfx]\b/gi;

const fold = (s: string): string =>
  s
    .replace(/ß/g, 'ss')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/\be\.\s?v\b\.?/gi, 'ev')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

export interface CompanyKeyInput {
  company?: string | null;
  title?: string | null;
  location?: string | null;
}

const normCompany = (company: string | null | undefined): string => {
  const tokens = fold(company ?? '')
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join(' ');
};
const normTitle = (title: string | null | undefined): string =>
  fold((title ?? '').replace(/\([^)]*\)/g, ' ').replace(GENDER_MARKER, ' '));
// A leading German postcode ("96047 Bamberg") is not part of the city.
const normCity = (location: string | null | undefined): string =>
  fold((location ?? '').replace(/^\s*\d{5}\s+/, ''));

/** Normalized company (legal suffix stripped) | title | city, only when all three are present. */
export function companyKey({ company, title, location }: CompanyKeyInput): string | null {
  const c = normCompany(company);
  const t = normTitle(title);
  const l = normCity(location);
  return c && t && l ? `${c}|${t}|${l}` : null;
}

/** Normalized company | city, only when both are present: Jobs in one bucket may be the same job. */
export function nearBucket({ company, location }: CompanyKeyInput): string | null {
  const c = normCompany(company);
  const l = normCity(location);
  return c && l ? `${c}|${l}` : null;
}

/** Jaccard overlap (0 to 1) of the normalized title words of two titles; 0 when either has none. */
export function titleOverlap(a: string, b: string): number {
  const x = new Set(normTitle(a).split(' ').filter(Boolean));
  const y = new Set(normTitle(b).split(' ').filter(Boolean));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/**
 * The URL without scheme, www, fragment, tracking parameters and trailing slash; parameters sorted.
 * A LinkedIn or Indeed job link is first reduced to the site's own job id.
 */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const site = siteJobId(raw);
  if (site) {
    url = new URL(
      site.site === 'linkedin'
        ? `https://linkedin.com/jobs/view/${site.id}`
        : `https://indeed.com/viewjob?jk=${site.id}`,
    );
  }
  const params = [...url.searchParams]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const host = url.host.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}${params ? `?${params}` : ''}`;
}
