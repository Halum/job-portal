import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createLogger } from '@job-portal/shared';
import { createApp } from '../src/app.js';

const logger = createLogger({ level: 'silent' });
const bearerToken = 'test-token';

function buildApp(overrides: { dbOk?: boolean; redisOk?: boolean } = {}) {
  const { dbOk = true, redisOk = true } = overrides;
  return createApp({
    bearerToken,
    logger,
    health: {
      checkDb: async () => {
        if (!dbOk) throw new Error('db down');
        return true;
      },
      checkRedis: async () => {
        if (!redisOk) throw new Error('redis down');
        return true;
      },
    },
  });
}

describe('GET /health', () => {
  it('returns 200 with status ok when db and redis are up', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('does not require auth', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
  });

  it('returns 503 when db is down', async () => {
    const app = buildApp({ dbOk: false });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'fail', db: 'fail', redis: 'ok' });
  });

  it('returns 503 when redis is down', async () => {
    const app = buildApp({ redisOk: false });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.redis).toBe('fail');
  });

  it('returns 503 when both are down', async () => {
    const app = buildApp({ dbOk: false, redisOk: false });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/ping (protected placeholder route)', () => {
  it('returns 401 without a token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ping').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a malformed Authorization header', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ping').set('Authorization', bearerToken);
    expect(res.status).toBe(401);
  });

  it('returns 200 with the correct token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/ping').set('Authorization', `Bearer ${bearerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });
});

describe('error handling middleware', () => {
  it('returns 500 and does not leak the raw error to the client', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/_throw')
      .set('Authorization', `Bearer ${bearerToken}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('GET /docs (Swagger UI, no auth)', () => {
  it('serves 200', async () => {
    const app = buildApp();
    // swagger-ui-express redirects /docs -> /docs/ then serves the HTML.
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
  });
});

describe('unmatched routes', () => {
  it('returns 404 for unknown paths', async () => {
    const app = buildApp();
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
