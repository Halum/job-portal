import { Router } from 'express';

export type DependencyCheck = () => Promise<boolean>;

export interface HealthDeps {
  checkDb: DependencyCheck;
  checkRedis: DependencyCheck;
}

/**
 * GET /health — no auth (PRD §12, §14). Returns 200 when both dependencies
 * are reachable, 503 otherwise. Each check is caller-supplied so it can be
 * swapped for a real Postgres/Redis ping in production and a mock in tests.
 */
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([safeCheck(deps.checkDb), safeCheck(deps.checkRedis)]);

    const allOk = dbOk && redisOk;

    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'fail',
      db: dbOk ? 'ok' : 'fail',
      redis: redisOk ? 'ok' : 'fail',
    });
  });

  return router;
}

async function safeCheck(check: DependencyCheck): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}
