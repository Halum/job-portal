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
      port: 3000,
      logLevel: 'info',
    });
  });

  it('reads overrides, coercing the port', () => {
    const config = loadConfig({
      ...valid,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      SEED_USER_EMAIL: 'me@example.invalid',
    });
    expect(config).toMatchObject({
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
});
