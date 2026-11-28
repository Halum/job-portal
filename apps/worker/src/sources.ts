import type { Watchlist } from '@job-portal/boards';
import type { Config } from '@job-portal/config';
import {
  ATS_IDS,
  BAMBASE,
  BUNDESAGENTUR,
  bundesagenturQuery,
  createAtsSource,
  createBambaseSource,
  createBundesagenturSource,
  createJsearchSource,
  JSEARCH,
  type RequestLog,
  type JsearchStats,
  type Source,
} from '@job-portal/discovery';
import type { Matching } from '@job-portal/matching';
import type { ScheduledSource } from './worker';

/**
 * Every configured Source and its schedule. Discovery snapshots the list it is given, so it must be
 * created from the result of this one call, after all Sources are in it.
 */
export function buildSources(
  config: Pick<Config, 'sources'>,
  deps: {
    matching: Pick<Matching, 'searchQueries' | 'textQueries'>;
    /** The marked directory boards, narrowed by the user's Watchlist. */
    watchlist: Pick<Watchlist, 'listBoards'>;
    /** The rate-limited fetch every ATS board request goes through (shared through Redis). */
    fetch: typeof fetch;
    userId: string;
    /** Where the JSearch Source records every request and reads its round-robin position back. */
    requestLog: RequestLog;
    /** Replaces the network for the Bundesagentur, bambase and JSearch requests (tests and dry runs). */
    directFetch?: typeof fetch;
  },
): { sources: Source[]; scheduled: ScheduledSource[]; jsearchStats: (() => JsearchStats) | null } {
  const sources: Source[] = [];
  const scheduled: ScheduledSource[] = [];
  const { bundesagentur, bambase } = config.sources;
  if (bundesagentur) {
    sources.push(
      createBundesagenturSource({
        queries: async () =>
          (await deps.matching.searchQueries(deps.userId)).map(bundesagenturQuery),
        ...(deps.directFetch ? { fetch: deps.directFetch } : {}),
      }),
    );
    scheduled.push({ sourceId: BUNDESAGENTUR, intervalMinutes: bundesagentur.intervalMinutes });
  }
  if (bambase) {
    sources.push(createBambaseSource(deps.directFetch ? { fetch: deps.directFetch } : {}));
    scheduled.push({ sourceId: BAMBASE, intervalMinutes: bambase.intervalMinutes });
  }
  let jsearchStats: (() => JsearchStats) | null = null;
  const { jsearch } = config.sources;
  if (jsearch) {
    const source = createJsearchSource({
      apiKeys: jsearch.apiKeys,
      requestLog: deps.requestLog,
      publishers: jsearch.publishers,
      country: jsearch.country,
      language: jsearch.language,
      queries: () => deps.matching.textQueries(deps.userId),
      ...(deps.directFetch ? { fetch: deps.directFetch } : {}),
    });
    sources.push(source);
    jsearchStats = source.stats;
    scheduled.push({ sourceId: JSEARCH, intervalMinutes: jsearch.intervalMinutes });
  }
  // Company boards: only marked boards of the Board directory (narrowed by the Watchlist) are fetched.
  for (const ats of ATS_IDS) {
    const source = config.sources[ats];
    if (!source) continue;
    sources.push(
      createAtsSource(ats, {
        listBoards: () => deps.watchlist.listBoards(deps.userId, ats),
        fetch: deps.fetch,
      }),
    );
    scheduled.push({ sourceId: ats, intervalMinutes: source.intervalMinutes });
  }
  return { sources, scheduled, jsearchStats };
}
