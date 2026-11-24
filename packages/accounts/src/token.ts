import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time comparison: hashing first gives equal-length buffers, so length leaks nothing. */
export function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Returns the token from an `Authorization: Bearer <token>` header, or null. */
export function bearerFromHeader(header: string | undefined): string | null {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  return match?.[1] ?? null;
}
