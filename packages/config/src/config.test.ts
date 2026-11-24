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
      prerankTopN: 20,
      boardRequestsPerSecond: 2,
      ai: null,
      aiMaxCallsPerRun: 50,
      alertThreshold: 70,
      notifications: null,
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
    it('is not scheduled until its interval is set, and an empty value counts as unset', () => {
      expect(loadConfig(valid).sources.bundesagentur).toBeNull();
      expect(
        loadConfig({ ...valid, BUNDESAGENTUR_INTERVAL_MINUTES: '' }).sources.bundesagentur,
      ).toBeNull();
    });

    it('reads the interval in minutes and no longer reads a query from the environment', () => {
      const env = { ...valid, BUNDESAGENTUR_INTERVAL_MINUTES: '15', BUNDESAGENTUR_QUERY: 'wo=x' };
      expect(loadConfig(env).sources.bundesagentur).toEqual({ intervalMinutes: 15 });
    });

    it.each(['0', '-5', '1.5', 'abc'])('rejects the interval %j', (value) => {
      const env = { ...valid, BUNDESAGENTUR_INTERVAL_MINUTES: value };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow('BUNDESAGENTUR_INTERVAL_MINUTES');
    });
  });

  describe('prerank default', () => {
    it('defaults to 20, reads an override, and needs an integer of at least 1', () => {
      expect(loadConfig(valid).prerankTopN).toBe(20);
      expect(loadConfig({ ...valid, PRERANK_TOP_N: '5' }).prerankTopN).toBe(5);
      for (const bad of ['0', '-1', '1.5', 'abc']) {
        expect(() => loadConfig({ ...valid, PRERANK_TOP_N: bad })).toThrow('PRERANK_TOP_N');
      }
    });
  });

  describe('bambase source', () => {
    it('is not scheduled until its interval is set, and an empty value counts as unset', () => {
      expect(loadConfig(valid).sources.bambase).toBeNull();
      expect(loadConfig({ ...valid, BAMBASE_INTERVAL_MINUTES: '' }).sources.bambase).toBeNull();
    });

    it('reads the interval in minutes, independent of the other sources', () => {
      const env = {
        ...valid,
        BAMBASE_INTERVAL_MINUTES: '30',
        BUNDESAGENTUR_INTERVAL_MINUTES: '60',
      };
      expect(loadConfig(env).sources).toEqual({
        bundesagentur: { intervalMinutes: 60 },
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

  describe('AI runner', () => {
    it('is off until AI_RUNNER is set, and an empty value counts as unset', () => {
      expect(loadConfig(valid).ai).toBeNull();
      expect(loadConfig({ ...valid, AI_RUNNER: '' }).ai).toBeNull();
    });

    it('reads the OpenRouter runner with its key and model', () => {
      const env = {
        ...valid,
        AI_RUNNER: 'openrouter',
        OPENROUTER_API_KEY: 'placeholder-key',
        OPENROUTER_MODEL: 'vendor/model',
      };
      expect(loadConfig(env).ai).toEqual({
        runner: 'openrouter',
        apiKey: 'placeholder-key',
        model: 'vendor/model',
      });
    });

    it('reads the claude runner with binary path (default claude), model and effort (default low)', () => {
      expect(loadConfig({ ...valid, AI_RUNNER: 'claude', CLAUDE_MODEL: 'sonnet' }).ai).toEqual({
        runner: 'claude',
        binaryPath: 'claude',
        model: 'sonnet',
        effort: 'low',
      });
      const env = {
        ...valid,
        AI_RUNNER: 'claude',
        CLAUDE_MODEL: 'opus',
        CLAUDE_BINARY_PATH: '/opt/claude',
        CLAUDE_EFFORT: 'high',
      };
      expect(loadConfig(env).ai).toEqual({
        runner: 'claude',
        binaryPath: '/opt/claude',
        model: 'opus',
        effort: 'high',
      });
    });

    it('does not need the settings of the other runner', () => {
      const env = { ...valid, AI_RUNNER: 'claude', CLAUDE_MODEL: 'sonnet', OPENROUTER_API_KEY: '' };
      expect(loadConfig(env).ai?.runner).toBe('claude');
    });

    it.each([
      [{ AI_RUNNER: 'openrouter', OPENROUTER_MODEL: 'm' }, 'OPENROUTER_API_KEY'],
      [{ AI_RUNNER: 'openrouter', OPENROUTER_API_KEY: 'k' }, 'OPENROUTER_MODEL'],
      [{ AI_RUNNER: 'claude' }, 'CLAUDE_MODEL'],
      [{ AI_RUNNER: 'claude', CLAUDE_MODEL: 'm', CLAUDE_EFFORT: 'huge' }, 'CLAUDE_EFFORT'],
      [{ AI_RUNNER: 'gpt' }, 'AI_RUNNER'],
    ])('rejects %j, naming %s', (extra, name) => {
      expect(() => loadConfig({ ...valid, ...extra })).toThrow(name);
    });
  });

  describe('AI call cap per run', () => {
    it('defaults to 50, reads an override and needs an integer of at least 1', () => {
      expect(loadConfig(valid).aiMaxCallsPerRun).toBe(50);
      expect(loadConfig({ ...valid, AI_MAX_CALLS_PER_RUN: '5' }).aiMaxCallsPerRun).toBe(5);
      for (const bad of ['0', '-1', '1.5', 'abc']) {
        expect(() => loadConfig({ ...valid, AI_MAX_CALLS_PER_RUN: bad })).toThrow(
          'AI_MAX_CALLS_PER_RUN',
        );
      }
    });
  });

  describe('notifications', () => {
    const hook = {
      NOTIFY_WEBHOOK_URL: 'https://hooks.example.invalid/webhook/placeholder',
      NOTIFY_TOPIC_ID: 'topic-placeholder',
    };

    it('is off when neither the webhook URL nor the topic id is set, empty counts as unset', () => {
      expect(loadConfig(valid).notifications).toBeNull();
      expect(
        loadConfig({ ...valid, NOTIFY_WEBHOOK_URL: '', NOTIFY_TOPIC_ID: '' }).notifications,
      ).toBeNull();
    });

    it('reads both settings with send defaults of 3 attempts and a 1000 ms backoff', () => {
      expect(loadConfig({ ...valid, ...hook }).notifications).toEqual({
        webhookUrl: hook.NOTIFY_WEBHOOK_URL,
        topicId: hook.NOTIFY_TOPIC_ID,
        maxAttempts: 3,
        backoffMs: 1000,
      });
    });

    it('reads the retry overrides and needs integers (attempts at least 1, backoff 0 or more)', () => {
      const n = loadConfig({
        ...valid,
        ...hook,
        NOTIFY_MAX_ATTEMPTS: '5',
        NOTIFY_BACKOFF_MS: '0',
      }).notifications;
      expect(n).toMatchObject({ maxAttempts: 5, backoffMs: 0 });
      for (const bad of ['0', '-1', '1.5', 'abc'])
        expect(() => loadConfig({ ...valid, ...hook, NOTIFY_MAX_ATTEMPTS: bad })).toThrow(
          'NOTIFY_MAX_ATTEMPTS',
        );
      expect(() => loadConfig({ ...valid, ...hook, NOTIFY_BACKOFF_MS: '-1' })).toThrow(
        'NOTIFY_BACKOFF_MS',
      );
    });

    it('needs the webhook URL and the topic id together', () => {
      expect(() => loadConfig({ ...valid, NOTIFY_WEBHOOK_URL: hook.NOTIFY_WEBHOOK_URL })).toThrow(
        'NOTIFY_TOPIC_ID',
      );
      expect(() => loadConfig({ ...valid, NOTIFY_TOPIC_ID: hook.NOTIFY_TOPIC_ID })).toThrow(
        'NOTIFY_WEBHOOK_URL',
      );
    });

    it('accepts only an http or https URL, and the error never echoes the URL', () => {
      for (const bad of ['not a url', 'ftp://hooks.example.invalid/x', 'file:///etc/passwd']) {
        let message = '';
        try {
          loadConfig({ ...valid, ...hook, NOTIFY_WEBHOOK_URL: bad });
        } catch (err) {
          message = err instanceof Error ? err.message : '';
        }
        expect(message).toContain('NOTIFY_WEBHOOK_URL');
        expect(message).not.toContain(bad);
      }
    });
  });

  describe('alert threshold default', () => {
    it('defaults to 70, reads 0 to 100 and rejects the rest', () => {
      expect(loadConfig(valid).alertThreshold).toBe(70);
      expect(loadConfig({ ...valid, ALERT_THRESHOLD: '0' }).alertThreshold).toBe(0);
      expect(loadConfig({ ...valid, ALERT_THRESHOLD: '100' }).alertThreshold).toBe(100);
      for (const bad of ['101', '-1', '1.5', 'abc']) {
        expect(() => loadConfig({ ...valid, ALERT_THRESHOLD: bad })).toThrow('ALERT_THRESHOLD');
      }
    });
  });
});
