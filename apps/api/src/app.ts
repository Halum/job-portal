import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Logger } from '@job-portal/shared';
import { bearerAuth } from './middleware/auth.js';
import { createHealthRouter, type HealthDeps } from './routes/health.js';
import { createPingRouter } from './routes/ping.js';
import { openapiSpec } from './openapi.js';

export interface CreateAppOptions {
  bearerToken: string;
  logger: Logger;
  health: HealthDeps;
}

/**
 * Builds the Express app without binding a port — kept separate from
 * apps/api/src/index.ts so tests can exercise it in-process with supertest.
 */
export function createApp(options: CreateAppOptions): Express {
  const { bearerToken, logger, health } = options;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  // /health and /docs are public (PRD §12, §14) — mounted before auth.
  app.use(createHealthRouter(health));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

  app.use(createPingRouter(bearerAuth(bearerToken)));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
