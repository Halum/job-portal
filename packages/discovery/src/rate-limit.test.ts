import { describe, expect, it } from 'vitest';
import {
  RateLimitError,
  connectRateLimiter,
  createMemorySlots,
  createRateLimitedFetch,
} from './rate-limit';

/** A virtual clock: sleeping advances time, so the test never waits. */
function setup(requestsPerSecond: number): {
  limited: typeof fetch;
  calls: { host: string; at: number }[];
} {
  let t = 0;
  const calls: { host: string; at: number }[] = [];
  const inner: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ host: new URL(url).host, at: t });
    return Promise.resolve(new Response('{}'));
  };
  const limited = createRateLimitedFetch(requestsPerSecond, inner, {
    slots: createMemorySlots(() => t),
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  });
  return { limited, calls };
}

describe('createRateLimitedFetch', () => {
  it('keeps requests to one host under the rate in every one-second window', async () => {
    const { limited, calls } = setup(2);
    for (let i = 0; i < 6; i += 1) await limited('https://a.example.invalid/x');
    expect(calls.map((c) => c.at)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it('paces each host on its own', async () => {
    const { limited, calls } = setup(1);
    await limited('https://a.example.invalid/x');
    await limited('https://b.example.invalid/x');
    await limited('https://a.example.invalid/y');
    expect(calls).toEqual([
      { host: 'a.example.invalid', at: 0 },
      { host: 'b.example.invalid', at: 0 },
      { host: 'a.example.invalid', at: 1000 },
    ]);
  });

  it('queues concurrent callers instead of bursting (real clock, total span only)', async () => {
    const stamps: number[] = [];
    const limited = createRateLimitedFetch(20, () => {
      stamps.push(Date.now());
      return Promise.resolve(new Response('{}'));
    });
    await Promise.all([1, 2, 3].map(() => limited(new URL('https://a.example.invalid/x'))));
    expect(stamps).toHaveLength(3);
    // gap is 50 ms, so three slots span at least 100 ms; a per-gap bound would flake under load,
    // the span cannot (timers fire late, never early, and the slots are booked 100 ms apart)
    const sorted = [...stamps].sort((a, b) => a - b);
    expect((sorted[2] ?? 0) - (sorted[0] ?? 0)).toBeGreaterThanOrEqual(95);
  });

  it('refuses a reservation that would wait past the maximum, and books nothing for it', async () => {
    let t = 0;
    const calls: number[] = [];
    const limited = createRateLimitedFetch(
      1,
      () => {
        calls.push(t);
        return Promise.resolve(new Response('{}'));
      },
      { slots: createMemorySlots(() => t, 2500), sleep: () => Promise.resolve() },
    );
    // slots at 0, 1000 and 2000 ms are within 2.5 s; the fourth would wait 3 s
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => limited('https://a.example.invalid/x')),
    );
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'rejected',
    ]);
    expect((results[3] as PromiseRejectedResult).reason).toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(3);
    t = 3000; // the refused callers booked nothing, so time moving on frees the host again
    await limited('https://a.example.invalid/x');
    expect(calls).toHaveLength(4);
  });

  it('fails fast with a clear error when Redis is down, and never sends the request', async () => {
    let sent = false;
    const errors: unknown[] = [];
    const limiter = connectRateLimiter({
      redisUrl: 'redis://127.0.0.1:1',
      requestsPerSecond: 5,
      inner: () => {
        sent = true;
        return Promise.resolve(new Response('{}'));
      },
      onError: (err) => errors.push(err),
    });
    const started = Date.now();
    await expect(limiter.fetch('https://a.example.invalid/x')).rejects.toThrow(
      /rate limit store unavailable/,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sent).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    limiter.close();
  });

  it('accepts a Request and refuses a rate of zero', async () => {
    const { limited, calls } = setup(1);
    await limited(new Request('https://a.example.invalid/x'));
    expect(calls).toHaveLength(1);
    expect(() => createRateLimitedFetch(0)).toThrow();
  });
});
