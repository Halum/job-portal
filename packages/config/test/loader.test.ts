import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../src/loader.js';
import { ConfigError } from '@job-portal/shared';

const fixturesDir = path.dirname(fileURLToPath(import.meta.url)) + '/fixtures';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  OPENROUTER_API_KEY: 'sk-test',
  API_BEARER_TOKEN: 'secret-token',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
};

describe('loadConfig', () => {
  it('parses valid sources.yaml + app.yaml + env', () => {
    const config = loadConfig({
      sourcesPath: `${fixturesDir}/sources.valid.yaml`,
      appConfigPath: `${fixturesDir}/app.valid.yaml`,
      env: validEnv,
    });

    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]?.name).toBe('arbeitsagentur-bamberg');
    expect(config.app.timezone).toBe('Europe/Berlin');
    expect(config.env.API_BEARER_TOKEN).toBe('secret-token');
  });

  it('rejects invalid sources.yaml', () => {
    expect(() =>
      loadConfig({
        sourcesPath: `${fixturesDir}/sources.invalid.yaml`,
        appConfigPath: `${fixturesDir}/app.valid.yaml`,
        env: validEnv,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects invalid app.yaml', () => {
    expect(() =>
      loadConfig({
        sourcesPath: `${fixturesDir}/sources.valid.yaml`,
        appConfigPath: `${fixturesDir}/app.invalid.yaml`,
        env: validEnv,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects missing required env vars', () => {
    const { DATABASE_URL: _drop, ...envWithoutDatabaseUrl } = validEnv;
    expect(() =>
      loadConfig({
        sourcesPath: `${fixturesDir}/sources.valid.yaml`,
        appConfigPath: `${fixturesDir}/app.valid.yaml`,
        env: envWithoutDatabaseUrl,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects a missing sources file with a clear error', () => {
    expect(() =>
      loadConfig({
        sourcesPath: `${fixturesDir}/does-not-exist.yaml`,
        appConfigPath: `${fixturesDir}/app.valid.yaml`,
        env: validEnv,
      }),
    ).toThrow(/Could not read sources config/);
  });
});
