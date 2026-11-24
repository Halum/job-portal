import type { SearchQuery } from './matching';

/** The only parameters of a saved search that reach the API; the adapter keeps the same list. */
const TEXT_PARAMS = ['was', 'wo', 'arbeitszeit', 'angebotsart', 'sort'] as const;

/**
 * Reads a saved Bundesagentur search URL (https, www.arbeitsagentur.de, under /jobsuche/suche) into
 * search parameters, keeping only the allowed ones. Returns an error message when it is refused.
 */
export function parseSearchUrl(raw: string): { query: SearchQuery } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'not a valid URL' };
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.arbeitsagentur.de' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !(url.pathname === '/jobsuche/suche' || url.pathname === '/jobsuche/suche/')
  )
    return { error: 'must be an https URL on www.arbeitsagentur.de under /jobsuche/suche' };
  const query: SearchQuery = {};
  for (const key of TEXT_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null && value.trim() !== '') query[key] = value;
  }
  const km = url.searchParams.get('umkreis');
  if (km !== null && /^\d{1,3}$/.test(km)) query.umkreis = Number(km);
  // A search with no usable parameter would fetch the whole country; Targets never do that either (ADR 0009).
  if (Object.keys(query).length === 0)
    return {
      error: 'has none of the search parameters was, wo, umkreis, arbeitszeit, angebotsart, sort',
    };
  return { query };
}

/** Same parameters, same key, whatever the order of the URL's parameters. */
export const queryKey = (q: SearchQuery): string => JSON.stringify(Object.entries(q).sort());
