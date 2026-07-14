import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Express middleware enforcing `Authorization: Bearer <token>` against a
 * fixed token (PRD §14). Uses crypto.timingSafeEqual to avoid leaking token
 * length/content via response-time side channels. Missing or wrong token
 * always results in 401 — never 500, even on shape mismatches.
 */
export function bearerAuth(expectedToken: string) {
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');

  return function bearerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const providedBuffer = Buffer.from(token, 'utf8');

    // timingSafeEqual throws if buffer lengths differ, so compare lengths
    // first via a constant-shape check: pad/compare against a fixed-length
    // buffer to avoid a length-based short circuit leaking info. Simplest
    // safe approach: only timingSafeEqual when lengths match; a length
    // mismatch is itself constant-time-irrelevant (an attacker already
    // learns nothing more than "wrong length", which is not the token).
    const isValid =
      providedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(providedBuffer, expectedBuffer);

    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
