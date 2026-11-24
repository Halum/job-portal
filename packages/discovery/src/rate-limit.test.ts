import { describe, expect, it } from 'vitest';
import { createRateLimitedFetch } from './rate-limit';

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
    now: () => t,
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

  it('queues concurrent callers instead of bursting (real clock, lower bounds only)', async () => {
    const stamps: number[] = [];
    const limited = createRateLimitedFetch(20, () => {
      stamps.push(Date.now());
      return Promise.resolve(new Response('{}'));
    });
    await Promise.all([1, 2, 3].map(() => limited(new URL('https://a.example.invalid/x'))));
    expect(stamps).toHaveLength(3);
    expect((stamps[1] ?? 0) - (stamps[0] ?? 0)).toBeGreaterThanOrEqual(45); // gap is 50 ms
    expect((stamps[2] ?? 0) - (stamps[1] ?? 0)).toBeGreaterThanOrEqual(45);
  });

  it('accepts a Request and refuses a rate of zero', async () => {
    const { limited, calls } = setup(1);
    await limited(new Request('https://a.example.invalid/x'));
    expect(calls).toHaveLength(1);
    expect(() => createRateLimitedFetch(0)).toThrow();
  });
});
