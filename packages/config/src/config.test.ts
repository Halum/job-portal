import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MCP_BEARER_TOKEN: 'a-long-enough-placeholder-token',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      mcpBearerToken: valid.MCP_BEARER_TOKEN,
      seedUserEmail: 'user@example.invalid',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      sources: { bundesagentur: null, bambase: null, greenhouse: null, lever: null, ashby: null },
      boardRequestsPerSecond: 2,
    });
  });

  it('reads overrides, coercing the port', () => {
    const config = loadConfig({
      ...valid,
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      SEED_USER_EMAIL: 'me@example.invalid',
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'debug',
      seedUserEmail: 'me@example.invalid',
    });
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'MCP_BEARER_TOKEN'])('fails when %s is missing', (key) => {
    const env = { ...valid, [key]: undefined };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('rejects a short bearer token and a bad port', () => {
    expect(() => loadConfig({ ...valid, MCP_BEARER_TOKEN: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: '0' })).toThrow(ConfigError);
  });

  describe('bundesagentur source', () => {
    it('is unset until a query is given, and then defaults to hourly', () => {
      expect(loadConfig({ ...valid, BUNDESAGENTUR_QUERY: 'wo=Musterstadt' }).sources).toEqual({
        bundesagentur: { query: 'wo=Musterstadt', intervalMinutes: 60 },
        bambase: null,
        greenhouse: null,
        lever: null,
        ashby: null,
      });
    });

    it('treats an empty query as unset', () => {
      expect(loadConfig({ ...valid, BUNDESAGENTUR_QUERY: '' }).sources.bundesagentur).toBeNull();
    });

    it('reads the interval in minutes', () => {
      const env = { ...valid, BUNDESAGENTUR_QUERY: 'wo=x', BUNDESAGENTUR_INTERVAL_MINUTES: '15' };
      expect(loadConfig(env).sources.bundesagentur?.intervalMinutes).toBe(15);
    });

    it.each(['0', '-5', '1.5', 'abc', ''])('rejects the interval %j', (value) => {
      const env = { ...valid, BUNDESAGENTUR_INTERVAL_MINUTES: value };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow('BUNDESAGENTUR_INTERVAL_MINUTES');
    });
  });

  describe('bambase source', () => {
    it('is not scheduled until its interval is set, and an empty value counts as unset', () => {
      expect(loadConfig(valid).sources.bambase).toBeNull();
      expect(loadConfig({ ...valid, BAMBASE_INTERVAL_MINUTES: '' }).sources.bambase).toBeNull();
    });

    it('reads the interval in minutes, independent of the other sources', () => {
      const env = { ...valid, BAMBASE_INTERVAL_MINUTES: '30', BUNDESAGENTUR_QUERY: 'wo=x' };
      expect(loadConfig(env).sources).toEqual({
        bundesagentur: { query: 'wo=x', intervalMinutes: 60 },
        bambase: { intervalMinutes: 30 },
        greenhouse: null,
        lever: null,
        ashby: null,
      });
    });

    it.each(['0', '-5', '1.5', 'abc'])('rejects the interval %j', (value) => {
      const env = { ...valid, BAMBASE_INTERVAL_MINUTES: value };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow('BAMBASE_INTERVAL_MINUTES');
    });
  });

  describe('company board sources', () => {
    it.each([
      ['greenhouse', 'GREENHOUSE_INTERVAL_MINUTES'],
      ['lever', 'LEVER_INTERVAL_MINUTES'],
      ['ashby', 'ASHBY_INTERVAL_MINUTES'],
    ] as const)('%s is scheduled only when its interval is set', (name, key) => {
      expect(loadConfig(valid).sources[name]).toBeNull();
      expect(loadConfig({ ...valid, [key]: '' }).sources[name]).toBeNull();
      expect(loadConfig({ ...valid, [key]: '45' }).sources[name]).toEqual({ intervalMinutes: 45 });
      expect(() => loadConfig({ ...valid, [key]: '0' })).toThrow(key);
    });

    it('reads the request rate per host, which must be above zero', () => {
      expect(
        loadConfig({ ...valid, BOARD_REQUESTS_PER_SECOND: '0.5' }).boardRequestsPerSecond,
      ).toBe(0.5);
      for (const bad of ['0', '-1', 'abc']) {
        expect(() => loadConfig({ ...valid, BOARD_REQUESTS_PER_SECOND: bad })).toThrow(
          'BOARD_REQUESTS_PER_SECOND',
        );
      }
    });
  });
});
