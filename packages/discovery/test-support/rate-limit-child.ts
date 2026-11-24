import { Redis } from 'ioredis';
import { createMemorySlots, createRateLimitedFetch, createRedisSlots } from '../src/rate-limit';

// Test helper, run as its own process by rate-limit.integration.test.ts: makes N limited requests
// to one host and prints when each reached the (stubbed) network.
const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} not set`);
  return v;
};
const redis = new Redis(env('REDIS_URL'));
const slots = env('LIMITER') === 'redis' ? createRedisSlots(redis) : createMemorySlots();
const stamps: number[] = [];
const limited = createRateLimitedFetch(
  Number(env('RPS')),
  () => {
    stamps.push(Date.now());
    return Promise.resolve(new Response('{}'));
  },
  { slots },
);
await new Promise((resolve) => setTimeout(resolve, Number(env('START_AT')) - Date.now()));
for (let i = 0; i < Number(env('REQUESTS')); i += 1) await limited('https://a.example.invalid/x');
process.stdout.write(JSON.stringify(stamps));
redis.disconnect();
