import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { loadConfig } from '@job-portal/config';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createMatching, matchingMigrations } from '@job-portal/matching';
import { buildSources } from './sources';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const BASE = 'https://www.arbeitsagentur.de/jobsuche/suche';

describe('saved Bundesagentur URLs through the composed Source', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let matching: ReturnType<typeof createMatching>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [matchingMigrations]);
    handle = createDb(container.getConnectionUri());
    matching = createMatching(handle.db, { loadJobs: () => Promise.resolve([]) });
  }, 120_000);

  afterAll(async () => {
    await handle.close();
    await container.stop();
  });

  const run = async (userId: string): Promise<URL[]> => {
    const requests: URL[] = [];
    const record = ((input: string | URL | Request) => {
      requests.push(
        new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      );
      return Promise.resolve(Response.json({ ergebnisliste: [] }));
    }) as typeof fetch;
    const config = loadConfig({
      DATABASE_URL: 'postgres://x.invalid/db',
      REDIS_URL: 'redis://x.invalid',
      MCP_BEARER_TOKEN: 'a-token-of-enough-length-1234567890',
      SEED_USER_EMAIL: 'user@example.invalid',
      BUNDESAGENTUR_INTERVAL_MINUTES: '60',
    });
    const { sources } = buildSources(config, {
      matching,
      watchlist: { listBoards: () => Promise.resolve([]) },
      fetch: () => Promise.reject(new Error('no network in tests')),
      directFetch: record,
      userId,
    });
    const source = sources.find((s) => s.id === 'bundesagentur');
    await source?.fetch();
    return requests;
  };

  it('sends one API request per saved URL with its filters, plus keyword searches, once each', async () => {
    await matching.updateGlobalDefaults(USER_A, {
      bundesagenturSearches: [
        `${BASE}?wo=Musterstadt&umkreis=15&arbeitszeit=tz&angebotsart=1&unknown=x`,
        `${BASE}?angebotsart=1&arbeitszeit=tz&umkreis=15&wo=Musterstadt`,
      ],
    });
    await matching.upsertTarget(USER_A, { name: 'only urls', criteria: {} });
    await matching.upsertTarget(USER_A, {
      name: 'words',
      criteria: {
        keywords: ['alpha'],
        bundesagenturSearches: [
          `${BASE}?wo=Musterstadt&umkreis=15&arbeitszeit=tz&angebotsart=1`,
          `${BASE}?wo=Beispielburg&umkreis=5`,
        ],
      },
    });
    const requests = await run(USER_A);
    expect(requests.map((r) => Object.fromEntries(r.searchParams))).toEqual([
      { wo: 'Musterstadt', umkreis: '15', arbeitszeit: 'tz', angebotsart: '1' },
      { wo: 'Beispielburg', umkreis: '5' },
      { was: 'alpha' },
    ]);
  });

  it('never fetches the saved URLs of another user', async () => {
    await matching.upsertTarget(USER_B, {
      name: 'b',
      criteria: { bundesagenturSearches: [`${BASE}?wo=Zweitstadt&umkreis=9`] },
    });
    const requests = await run(USER_B);
    expect(requests.map((r) => r.searchParams.get('wo'))).toEqual(['Zweitstadt']);
  });
});
