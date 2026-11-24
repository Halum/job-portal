import { describe, expect, it } from 'vitest';
import { bearerFromHeader, tokensEqual } from './token';

describe('tokensEqual', () => {
  it('accepts the identical token', () => {
    expect(tokensEqual('placeholder-token-1234', 'placeholder-token-1234')).toBe(true);
  });

  it('rejects a different token, including one of another length and the empty string', () => {
    expect(tokensEqual('placeholder-token-1234', 'placeholder-token-1235')).toBe(false);
    expect(tokensEqual('placeholder-token-1234', 'short')).toBe(false);
    expect(tokensEqual('placeholder-token-1234', '')).toBe(false);
  });
});

describe('bearerFromHeader', () => {
  it('extracts the token from a Bearer header', () => {
    expect(bearerFromHeader('Bearer abc.def')).toBe('abc.def');
    expect(bearerFromHeader('bearer abc')).toBe('abc');
  });

  it('returns null for a missing or non-bearer header', () => {
    expect(bearerFromHeader(undefined)).toBeNull();
    expect(bearerFromHeader('Basic abc')).toBeNull();
    expect(bearerFromHeader('Bearer ')).toBeNull();
  });
});
