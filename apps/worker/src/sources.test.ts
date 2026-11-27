import { describe, expect, it } from 'vitest';
import { loadConfig } from '@job-portal/config';
import { buildSources } from './sources';

const deps = {
  matching: { searchQueries: () => Promise.resolve([]), textQueries: () => Promise.resolve([]) },
  watchlist: { listBoards: () => Promise.resolve([]) },
  fetch: () => Promise.reject(new Error('no network in tests')),
  userId: '00000000-0000-4000-8000-000000000001',
};

const base = {
  DATABASE_URL: 'postgres://x.invalid/db',
  REDIS_URL: 'redis://x.invalid',
  MCP_BEARER_TOKEN: 'a-token-of-enough-length-1234567890',
  SEED_USER_EMAIL: 'user@example.invalid',
};

describe('buildSources', () => {
  it('has a Source for every scheduled source id, ATS boards and JSearch included', () => {
    const config = loadConfig({
      ...base,
      BUNDESAGENTUR_INTERVAL_MINUTES: '60',
      BAMBASE_INTERVAL_MINUTES: '60',
      GREENHOUSE_INTERVAL_MINUTES: '60',
      LEVER_INTERVAL_MINUTES: '60',
      ASHBY_INTERVAL_MINUTES: '60',
      JSEARCH_INTERVAL_MINUTES: '720',
      JSEARCH_API_KEYS: 'test-key-1',
    });
    const { sources, scheduled, jsearchStats } = buildSources(config, deps);
    const known = new Set(sources.map((s) => s.id));
    expect(scheduled.map((s) => s.sourceId).sort()).toEqual(
      ['ashby', 'bambase', 'bundesagentur', 'greenhouse', 'jsearch', 'lever'].sort(),
    );
    expect(scheduled.find((s) => s.sourceId === 'jsearch')?.intervalMinutes).toBe(720);
    for (const { sourceId } of scheduled) expect(known.has(sourceId)).toBe(true);
    expect(jsearchStats?.()).toEqual({ requests: 0, keyPosition: 1 });
  });

  it('builds no JSearch Source without an interval or without a key', () => {
    for (const env of [{ JSEARCH_API_KEYS: 'test-key-1' }, { JSEARCH_INTERVAL_MINUTES: '720' }]) {
      const { sources, scheduled, jsearchStats } = buildSources(
        loadConfig({ ...base, ...env }),
        deps,
      );
      expect(sources).toEqual([]);
      expect(scheduled).toEqual([]);
      expect(jsearchStats).toBeNull();
    }
  });

  it('feeds JSearch from the text queries of the active Targets, over the replaceable fetch', async () => {
    const urls: string[] = [];
    const config = loadConfig({
      ...base,
      JSEARCH_INTERVAL_MINUTES: '720',
      JSEARCH_API_KEYS: 'test-key-1',
      JSEARCH_PUBLISHERS: 'any',
    });
    const { sources } = buildSources(config, {
      ...deps,
      matching: {
        ...deps.matching,
        textQueries: () =>
          Promise.resolve([{ keyword: 'koch', location: 'Musterstadt', radiusKm: 7 }]),
      },
      directFetch: ((u: string) => {
        urls.push(u);
        return Promise.resolve(Response.json({ data: { jobs: [] } }));
      }) as unknown as typeof fetch,
    });
    await sources[0]?.fetch();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').searchParams.get('query')).toBe('koch in Musterstadt');
    expect(new URL(urls[0] ?? '').searchParams.get('radius')).toBe('7');
  });
});
