import { Redis } from 'ioredis';

/** A rate-limit refusal or outage whose message is safe to show a user (never Redis's own text). */
export class RateLimitError extends Error {
  override name = 'RateLimitError';
}

/** The longest a request may be told to wait for its slot; a longer queue is refused, not booked. */
export const MAX_WAIT_MS = 30_000;

/**
 * Hands out request slots per host: reserve returns how many ms the caller must wait before its
 * request, and books the slot so the next caller gets a later one. It throws RateLimitError, and
 * books nothing, when the wait would pass the maximum.
 */
export interface SlotStore {
  reserve: (host: string, gapMs: number) => Promise<number>;
}

const tooLong = (): RateLimitError =>
  new RateLimitError('too many requests queued for this host, try again later');

/** Slots kept in this process only: fine for tests and for one process alone on a host. */
export function createMemorySlots(
  now: () => number = Date.now,
  maxWaitMs: number = MAX_WAIT_MS,
): SlotStore {
  const nextSlot = new Map<string, number>();
  return {
    reserve(host, gapMs) {
      const t = now();
      const at = Math.max(nextSlot.get(host) ?? 0, t);
      if (at - t > maxWaitMs) return Promise.reject(tooLong());
      nextSlot.set(host, at + gapMs);
      return Promise.resolve(at - t);
    },
  };
}

// One atomic step on Redis's own clock (so processes with drifting clocks agree): the next free
// slot for the host is the later of "now" and the slot after the last one booked. A slot past the
// maximum wait is refused (-1) and not booked, so a flood cannot push every worker far out.
const RESERVE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local at = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), now)
if at - now > tonumber(ARGV[2]) then return -1 end
redis.call('SET', KEYS[1], at + ARGV[1], 'PX', at - now + ARGV[1] + 60000)
return at - now
`;

const unavailable = (): RateLimitError => new RateLimitError('rate limit store unavailable');

/**
 * Slots shared through Redis, so every worker and the API together stay under the rate for a host.
 * ponytail: a token bucket with no burst (one slot per gap); if Redis is down the request fails
 * (RateLimitError) rather than going out unpaced.
 */
export function createRedisSlots(redis: Redis, maxWaitMs: number = MAX_WAIT_MS): SlotStore {
  return {
    async reserve(host, gapMs) {
      let wait: number;
      try {
        // whole ms, rounded up: the real rate can only be at or under the configured one
        wait = Number(
          await redis.eval(
            RESERVE,
            1,
            `ratelimit:${host}`,
            String(Math.ceil(gapMs)),
            String(maxWaitMs),
          ),
        );
      } catch (cause) {
        throw new RateLimitError(unavailable().message, { cause });
      }
      if (wait < 0) throw tooLong();
      return wait;
    },
  };
}

// Counts a hit in a fixed window; the first hit sets the window's expiry. One atomic step.
const HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * At most max calls per key in each fixed window, counted on Redis so every process agrees.
 * Returns true when the call is allowed. A Redis outage throws RateLimitError (fail closed).
 */
export function createRedisLimit(
  redis: Redis,
  { max, windowMs, prefix }: { max: number; windowMs: number; prefix: string },
): (key: string) => Promise<boolean> {
  return async (key) => {
    try {
      return Number(await redis.eval(HIT, 1, `${prefix}:${key}`, String(windowMs))) <= max;
    } catch (cause) {
      throw new RateLimitError(unavailable().message, { cause });
    }
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

export interface RateLimiterOptions {
  redisUrl: string;
  requestsPerSecond: number;
  inner?: typeof fetch;
  /** Called with every Redis connection error (the client keeps retrying in the background). */
  onError: (err: unknown) => void;
}

export interface RateLimiter {
  /** The rate-limited fetch, paced through Redis together with every other process. */
  fetch: typeof fetch;
  /** The same connection, for other counters (createRedisLimit). */
  redis: Redis;
  close: () => void;
}

/**
 * The one way a process joins the shared limit: a Redis client that fails a command after one
 * retry (so a down Redis fails requests fast instead of hanging them) and reports its errors.
 */
export function connectRateLimiter({
  redisUrl,
  requestsPerSecond,
  inner = fetch,
  onError,
}: RateLimiterOptions): RateLimiter {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', onError);
  return {
    fetch: createRateLimitedFetch(requestsPerSecond, inner, { slots: createRedisSlots(redis) }),
    redis,
    close: () => {
      redis.disconnect();
    },
  };
}
