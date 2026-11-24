import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { createLogger } from '@job-portal/shared';
import { startWorker } from './worker';

describe('worker against real Redis', () => {
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('connects to Redis through BullMQ, reports ready and closes cleanly', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      name: 'worker',
      destination: { write: (line: string) => void lines.push(line) },
    });

    const worker = await startWorker(redis.getConnectionUrl(), logger);
    expect(lines.some((l) => l.includes('worker ready'))).toBe(true);
    await worker.close();
  });

  it('fails fast when Redis is unreachable', async () => {
    await expect(
      startWorker('redis://127.0.0.1:1', createLogger({ level: 'silent' }), 500),
    ).rejects.toThrow();
  });
});
