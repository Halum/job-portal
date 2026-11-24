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

/** Normalized company (legal suffix stripped) | title | city, only when all three are present. */
export function companyKey({ company, title, location }: CompanyKeyInput): string | null {
  const tokens = fold(company ?? '')
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_TOKENS.has(tokens.at(-1) ?? '')) tokens.pop();
  const c = tokens.join(' ');
  const t = fold((title ?? '').replace(/\([^)]*\)/g, ' ').replace(GENDER_MARKER, ' '));
  // A leading German postcode ("96047 Bamberg") is not part of the city.
  const l = fold((location ?? '').replace(/^\s*\d{5}\s+/, ''));
  return c && t && l ? `${c}|${t}|${l}` : null;
}

/** The URL without scheme, www, fragment, tracking parameters and trailing slash; parameters sorted. */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const params = [...url.searchParams]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const host = url.host.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}${params ? `?${params}` : ''}`;
}
