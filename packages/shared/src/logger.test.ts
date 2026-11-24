import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  it('uses the given level and defaults to info', () => {
    expect(createLogger({ level: 'debug', name: 'api' }).level).toBe('debug');
    expect(createLogger().level).toBe('info');
  });
});
