import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { AppError, AuthError, ConfigError, DependencyError, NotFoundError } from './errors.js';

describe('createLogger', () => {
  it('creates a pino logger with the requested level', () => {
    const logger = createLogger({ level: 'debug', name: 'test' });
    expect(logger.level).toBe('debug');
  });

  it('defaults to info level', () => {
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });
});

describe('error classes', () => {
  it('AppError defaults to operational with APP_ERROR code', () => {
    const err = new AppError('boom');
    expect(err.code).toBe('APP_ERROR');
    expect(err.isOperational).toBe(true);
    expect(err.message).toBe('boom');
  });

  it('ConfigError carries CONFIG_ERROR code', () => {
    const err = new ConfigError('bad config');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err).toBeInstanceOf(AppError);
  });

  it('AuthError defaults message to Unauthorized', () => {
    const err = new AuthError();
    expect(err.message).toBe('Unauthorized');
    expect(err.code).toBe('AUTH_ERROR');
  });

  it('NotFoundError defaults message', () => {
    const err = new NotFoundError();
    expect(err.code).toBe('NOT_FOUND');
  });

  it('DependencyError carries cause', () => {
    const cause = new Error('conn refused');
    const err = new DependencyError('db down', { cause });
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('DEPENDENCY_ERROR');
  });
});
