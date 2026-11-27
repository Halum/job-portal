/** The site's own job id of a LinkedIn or Indeed job link, so copies of one job share one key. */

export interface SiteJobId {
  site: 'linkedin' | 'indeed';
  id: string;
}

const INDEED_HOST = /(^|\.)indeed\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/;
const INDEED_ID = /^[a-z0-9]+$/i;

function linkedinId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  if (url.pathname.includes('/jobs/view/')) {
    const last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    // No regex: a long digit run not at the end would take quadratic time.
    let start = last.length;
    while (start > 0 && last.charAt(start - 1) >= '0' && last.charAt(start - 1) <= '9') start -= 1;
    if (start < last.length) return last.slice(start);
  }
  if (url.pathname === '/jobs' || url.pathname.startsWith('/jobs/')) {
    const current = url.searchParams.get('currentJobId');
    if (current !== null && /^\d+$/.test(current)) return current;
  }
  return null;
}

function indeedId(url: URL): string | null {
  if (!INDEED_HOST.test(url.hostname.toLowerCase())) return null;
  for (const name of ['jk', 'vjk']) {
    const value = url.searchParams.get(name);
    if (value !== null && INDEED_ID.test(value)) return value.toLowerCase();
  }
  return null;
}

/** `{site, id}` for a LinkedIn or Indeed job link on any of the site's hosts, otherwise null. */
export function siteJobId(raw: string): SiteJobId | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const linkedin = linkedinId(url);
  if (linkedin !== null) return { site: 'linkedin', id: linkedin };
  const indeed = indeedId(url);
  return indeed === null ? null : { site: 'indeed', id: indeed };
}
