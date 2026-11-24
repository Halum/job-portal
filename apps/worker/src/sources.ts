import type { BoardDirectory } from '@job-portal/boards';
import type { Config } from '@job-portal/config';
import {
  ATS_IDS,
  BAMBASE,
  BUNDESAGENTUR,
  bundesagenturQuery,
  createAtsSource,
  createBambaseSource,
  createBundesagenturSource,
  createRateLimitedFetch,
  type Source,
} from '@job-portal/discovery';
import type { Matching } from '@job-portal/matching';
import type { ScheduledSource } from './worker';

/**
 * Every configured Source and its schedule. Discovery snapshots the list it is given, so it must be
 * created from the result of this one call, after all Sources are in it.
 */
export function buildSources(
  config: Pick<Config, 'sources' | 'boardRequestsPerSecond'>,
  deps: {
    matching: Pick<Matching, 'searchQueries'>;
    directory: Pick<BoardDirectory, 'listMarked'>;
    userId: string;
  },
): { sources: Source[]; scheduled: ScheduledSource[] } {
  const sources: Source[] = [];
  const scheduled: ScheduledSource[] = [];
  const { bundesagentur, bambase } = config.sources;
  if (bundesagentur) {
    sources.push(
      createBundesagenturSource({
        queries: async () =>
          (await deps.matching.searchQueries(deps.userId)).map(bundesagenturQuery),
      }),
    );
    scheduled.push({ sourceId: BUNDESAGENTUR, intervalMinutes: bundesagentur.intervalMinutes });
  }
  if (bambase) {
    sources.push(createBambaseSource());
    scheduled.push({ sourceId: BAMBASE, intervalMinutes: bambase.intervalMinutes });
  }
  // Company boards: only marked boards of the Board directory are fetched, at a bounded rate per ATS host.
  const limitedFetch = createRateLimitedFetch(config.boardRequestsPerSecond);
  for (const ats of ATS_IDS) {
    const source = config.sources[ats];
    if (!source) continue;
    sources.push(
      createAtsSource(ats, {
        listBoards: () => deps.directory.listMarked(ats),
        fetch: limitedFetch,
      }),
    );
    scheduled.push({ sourceId: ats, intervalMinutes: source.intervalMinutes });
  }
  return { sources, scheduled };
}
