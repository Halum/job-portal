export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wraps fetch so that requests to one host start at least 1000 / requestsPerSecond ms apart:
 * in any one-second window a host sees at most requestsPerSecond requests. Slots are reserved
 * synchronously, so concurrent callers in one process queue up in order.
 * ponytail: per process; several workers share a host only when they poll different sources.
 */
export function createRateLimitedFetch(
  requestsPerSecond: number,
  inner: typeof fetch = fetch,
  clock: Clock = realClock,
): typeof fetch {
  if (!(requestsPerSecond > 0)) throw new Error('requestsPerSecond must be above 0');
  const gapMs = 1000 / requestsPerSecond;
  const nextSlot = new Map<string, number>();
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    const now = clock.now();
    const at = Math.max(nextSlot.get(host) ?? 0, now);
    nextSlot.set(host, at + gapMs);
    if (at > now) await clock.sleep(at - now);
    return inner(input, init);
  };
}
