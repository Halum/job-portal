import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { loadConfig } from '@job-portal/config';
import { createLogger } from '@job-portal/shared';
import { composeApp, type App } from './compose';

const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';
const BASE = 'https://www.arbeitsagentur.de/jobsuche/suche';

describe('saved Bundesagentur URLs in the composed worker run', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: App;
  const requests: URL[] = [];

  const network = ((input: string | URL | Request) => {
    requests.push(
      new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
    );
    return Promise.resolve(Response.json({ ergebnisliste: [] }));
  }) as typeof fetch;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const config = loadConfig({
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      MCP_BEARER_TOKEN: 'a-token-of-enough-length-1234567890',
      LOG_LEVEL: 'error',
      BUNDESAGENTUR_INTERVAL_MINUTES: '1',
    });
    app = await composeApp(config, createLogger({ level: 'silent' }), { fetch: network });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it("sends one API request per saved URL with its filters intact, and never another user's URL", async () => {
    await app.matching.updateGlobalDefaults(app.user.id, {
      bundesagenturSearches: [
        `${BASE}?wo=Musterstadt&umkreis=15&arbeitszeit=tz&angebotsart=1&unknown=x`,
      ],
    });
    await app.matching.upsertTarget(app.user.id, {
      name: 'urls',
      criteria: { bundesagenturSearches: [`${BASE}?wo=Beispielburg&umkreis=5`] },
    });
    await app.matching.upsertTarget(app.user.id, { name: 'inherits', criteria: {} });
    await app.matching.upsertTarget(OTHER_USER, {
      name: 'other',
      criteria: { bundesagenturSearches: [`${BASE}?wo=Zweitstadt&umkreis=9`] },
    });

    await app.pipeline.execute(app.user.id, 'bundesagentur');

    const api = requests.filter((r) => r.hostname === 'rest.arbeitsagentur.de');
    expect(api.map((r) => Object.fromEntries(r.searchParams))).toEqual([
      { wo: 'Musterstadt', umkreis: '15', arbeitszeit: 'tz', angebotsart: '1' },
      { wo: 'Beispielburg', umkreis: '5' },
    ]);
  });
});
