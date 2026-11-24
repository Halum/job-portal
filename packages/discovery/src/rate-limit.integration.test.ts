import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

const run = promisify(execFile);
const child = fileURLToPath(new URL('../test-support/rate-limit-child.ts', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));
const RPS = 5;
const EACH = 6;
const JITTER_MS = 40;

describe('per-host rate limit shared across processes (real Redis)', () => {
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
  });
  afterAll(async () => {
    await redis.stop();
  });

  /** Two separate node processes hit the same host at the same moment; returns every request time, sorted. */
  async function twoProcesses(limiter: 'redis' | 'memory'): Promise<number[]> {
    const env = {
      ...process.env,
      REDIS_URL: redis.getConnectionUrl(),
      LIMITER: limiter,
      RPS: String(RPS),
      REQUESTS: String(EACH),
      START_AT: String(Date.now() + 3000),
    };
    const runs = await Promise.all(
      [1, 2].map(() => run(process.execPath, ['--import', 'tsx', child], { cwd: root, env })),
    );
    return runs.flatMap((r) => JSON.parse(r.stdout) as number[]).sort((a, b) => a - b);
  }

  /** True when some one-second window holds more than RPS requests. */
  const overRate = (stamps: number[]): boolean =>
    stamps.some((t, i) => {
      const later = stamps[i + RPS];
      return later !== undefined && later - t < 1000 - JITTER_MS;
    });

  it('keeps two processes together under the rate', async () => {
    const stamps = await twoProcesses('redis');
    expect(stamps).toHaveLength(2 * EACH);
    expect(overRate(stamps)).toBe(false);
  }, 60_000);

  it('would be broken by a per-process limiter (the check can fail)', async () => {
    expect(overRate(await twoProcesses('memory'))).toBe(true);
  }, 60_000);
});
