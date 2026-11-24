import { describe, expect, it } from 'vitest';
import { smokeRefusal } from './smoke-guard';

describe('smokeRefusal', () => {
  it('allows a plain environment', () => {
    expect(smokeRefusal({})).toBeNull();
    expect(smokeRefusal({ NODE_ENV: 'production', CI: '' })).toBeNull();
  });

  it('refuses under test and in CI', () => {
    expect(smokeRefusal({ NODE_ENV: 'test' })).toMatch(/NODE_ENV=test/);
    expect(smokeRefusal({ CI: 'true' })).toMatch(/CI/);
  });
});
