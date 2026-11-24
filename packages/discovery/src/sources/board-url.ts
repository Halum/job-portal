import type { Ats } from './ats';

/** What a careers URL resolves to: the ATS, the board id its API takes, and Lever's EU host. */
export interface ResolvedBoard {
  ats: Ats;
  token: string;
  host?: 'eu';
}

const TOKEN = /^[A-Za-z0-9._-]+$/;

/** A board id is safe in an ATS URL path: plain characters only, and never "." or ".." (path traversal). */
export function isValidBoardToken(token: string): boolean {
  return TOKEN.test(token) && token !== '.' && token !== '..';
}

const GREENHOUSE_HOSTS = new Set([
  'boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function greenhouse(url: URL, segments: string[]): string | undefined {
  if (url.hostname === 'boards-api.greenhouse.io') {
    return segments[0] === 'v1' && segments[1] === 'boards' ? segments[2] : undefined;
  }
  if (!GREENHOUSE_HOSTS.has(url.hostname)) return undefined;
  return segments[0] === 'embed' ? (url.searchParams.get('for') ?? undefined) : segments[0];
}

/**
 * Recognises a Greenhouse, Lever or Ashby careers URL and extracts the board id; null for anything
 * else. Hosts are matched exactly, so a lookalike host or a URL with credentials never resolves.
 */
export function resolveBoardUrl(input: string): ResolvedBoard | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const segments = url.pathname.split('/').filter((s) => s !== '');

  let found: ResolvedBoard | undefined;
  const g = greenhouse(url, segments);
  if (g !== undefined) found = { ats: 'greenhouse', token: g };
  else if (url.hostname === 'jobs.lever.co' && segments[0] !== undefined)
    found = { ats: 'lever', token: segments[0] };
  else if (url.hostname === 'jobs.eu.lever.co' && segments[0] !== undefined)
    found = { ats: 'lever', token: segments[0], host: 'eu' };
  else if (url.hostname === 'jobs.ashbyhq.com' && segments[0] !== undefined)
    found = { ats: 'ashby', token: segments[0] };

  return found !== undefined && isValidBoardToken(found.token) ? found : null;
}
