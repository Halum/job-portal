import type { Redis } from 'ioredis';

/**
 * Hands out request slots per host: reserve returns how many ms the caller must wait before its
 * request, and books the slot so the next caller gets a later one.
 */
export interface SlotStore {
  reserve: (host: string, gapMs: number) => Promise<number>;
}

/** Slots kept in this process only: fine for tests and for one process alone on a host. */
export function createMemorySlots(now: () => number = Date.now): SlotStore {
  const nextSlot = new Map<string, number>();
  return {
    reserve(host, gapMs) {
      const t = now();
      const at = Math.max(nextSlot.get(host) ?? 0, t);
      nextSlot.set(host, at + gapMs);
      return Promise.resolve(at - t);
    },
  };
}

// One atomic step on Redis's own clock (so processes with drifting clocks agree): the next free
// slot for the host is the later of "now" and the slot after the last one booked.
const RESERVE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local at = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), now)
redis.call('SET', KEYS[1], at + ARGV[1], 'PX', at - now + ARGV[1] + 60000)
return at - now
`;

/**
 * Slots shared through Redis, so every worker and the API together stay under the rate for a host.
 * ponytail: a token bucket with no burst (one slot per gap); if Redis is down every request fails
 * and the board shows as an error line rather than going out unpaced.
 */
export function createRedisSlots(redis: Redis): SlotStore {
  return {
    async reserve(host, gapMs) {
      // whole ms, rounded up: the real rate can only be at or under the configured one
      const wait = await redis.eval(RESERVE, 1, `ratelimit:${host}`, String(Math.ceil(gapMs)));
      return Number(wait);
    },
  };
}

export interface RateLimitOptions {
  slots?: SlotStore;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps fetch so that requests to one host start at least 1000 / requestsPerSecond ms apart:
 * in any one-second window a host sees at most requestsPerSecond requests. Slots come from a
 * SlotStore: in memory by default, Redis to share the limit between processes.
 */
export function createRateLimitedFetch(
  requestsPerSecond: number,
  inner: typeof fetch = fetch,
  {
    slots = createMemorySlots(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: RateLimitOptions = {},
): typeof fetch {
  if (!(requestsPerSecond > 0)) throw new Error('requestsPerSecond must be above 0');
  const gapMs = 1000 / requestsPerSecond;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const wait = await slots.reserve(new URL(url).host, gapMs);
    if (wait > 0) await sleep(wait);
    return inner(input, init);
  };
}
