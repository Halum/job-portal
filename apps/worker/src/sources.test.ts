import { describe, expect, it } from 'vitest';
import { loadConfig } from '@job-portal/config';
import { buildSources } from './sources';

const deps = {
  matching: { searchQueries: () => Promise.resolve([]) },
  watchlist: { listBoards: () => Promise.resolve([]) },
  fetch: () => Promise.reject(new Error('no network in tests')),
  userId: '00000000-0000-4000-8000-000000000001',
};

describe('buildSources', () => {
  it('has a Source for every scheduled source id, ATS boards included', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x.invalid/db',
      REDIS_URL: 'redis://x.invalid',
      MCP_BEARER_TOKEN: 'a-token-of-enough-length-1234567890',
      SEED_USER_EMAIL: 'user@example.invalid',
      BUNDESAGENTUR_INTERVAL_MINUTES: '60',
      BAMBASE_INTERVAL_MINUTES: '60',
      GREENHOUSE_INTERVAL_MINUTES: '60',
      LEVER_INTERVAL_MINUTES: '60',
      ASHBY_INTERVAL_MINUTES: '60',
    });
    const { sources, scheduled } = buildSources(config, deps);
    const known = new Set(sources.map((s) => s.id));
    expect(scheduled.map((s) => s.sourceId).sort()).toEqual(
      ['ashby', 'bambase', 'bundesagentur', 'greenhouse', 'lever'].sort(),
    );
    for (const { sourceId } of scheduled) expect(known.has(sourceId)).toBe(true);
  });
});
