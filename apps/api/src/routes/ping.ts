import { Router, type RequestHandler } from 'express';

/**
 * Protected placeholder route proving the bearer-auth middleware works end to
 * end. Real admin/pull routes land in later sprints.
 */
export function createPingRouter(auth: RequestHandler): Router {
  const router = Router();

  router.get('/api/ping', auth, (_req, res) => {
    res.status(200).json({ pong: true });
  });

  // Exercises the app's error-handling middleware in tests; not a real route.
  router.get('/api/_throw', auth, () => {
    throw new Error('boom');
  });

  return router;
}
