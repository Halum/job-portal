import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createJsearchSource,
  poolOf,
  type JsearchOptions,
  type RequestLog,
  type RequestLogEntry,
  type SlotPool,
} from './jsearch';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const fixture = load('jsearch-search.json');
const linkedinFixture = load('linkedin-search.json');
const indeedFixture = load('indeed-search.json');

/** The request log in memory, with the same reading rule as the Discovery table. */
function memoryLog(): RequestLog & { entries: RequestLogEntry[] } {
  const entries: RequestLogEntry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
    lastSlot: (pool: SlotPool) => {
      const last = entries.findLast((e) => poolOf(e.publisher) === pool);
      return Promise.resolve(last ? { api: last.api, keyPosition: last.keyPosition } : null);
    },
  };
}
const emptyBody = { data: { jobs: [] } };

interface Call {
  url: URL;
  key: string | null;
  signal: boolean;
  /** Which API the request went to. */
  api: string;
}

/** Answers each request from the next entry of `answers`, the last one repeating. Status 200 serves the body. */
function fakeFetch(...answers: { status: number; body?: unknown }[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const api = url.pathname.split('/')[1] ?? '';
    calls.push({
      url,
      api: api === 'jsearch' ? 'jsearch' : api === 'realtime-linkedin-data' ? 'linkedin' : 'indeed',
      key: new Headers(init?.headers).get('x-api-key'),
      signal: init?.signal != null,
    });
    const answer = answers[Math.min(calls.length, answers.length) - 1] ?? { status: 200 };
    const body =
      api === 'realtime-linkedin-data'
        ? linkedinFixture
        : api === 'realtime-indeed-data'
          ? indeedFixture
          : fixture;
    return Promise.resolve(new Response(JSON.stringify(answer.body ?? body), answer));
  };
  return { fetch: fetchImpl, calls };
}

const ok = { status: 200 };
const refused = (status: number): { status: number; body: unknown } => ({ status, body: {} });

const build = (
  over: Partial<JsearchOptions> & { fetch: typeof fetch },
): ReturnType<typeof createJsearchSource> =>
  createJsearchSource({
    apiKeys: ['test-key-1', 'test-key-2'],
    requestLog: memoryLog(),
    publishers: [],
    country: 'de',
    queries: () => Promise.resolve([{ keyword: 'koch', location: 'Musterstadt' }]),
    ...over,
  });

describe('jsearch source', () => {
  describe('normalisation', () => {
    it('reads every recorded result and reports the one without a job id', async () => {
      const { fetch } = fakeFetch(ok);
      const source = build({ fetch });
      const { postings, errors } = await source.fetch();

      expect(source.id).toBe('jsearch');
      expect(errors).toEqual(['result without job_id: Beispiel Stelle ohne Kennung']);
      expect(postings.map((p) => p.sourcePostingId)).toEqual([
        'fixture-job-1',
        'fixture-job-2',
        'fixture-job-3',
      ]);
      expect(postings[0]).toMatchObject({
        title: 'Beispiel Stelle A (m/w/d)',
        company: 'Beispiel Firma A',
        location: 'Musterstadt',
        publisher: 'LinkedIn',
      });
      expect(postings[0]?.postedAt).toEqual(new Date('2026-07-09T08:30:00.000Z'));
      expect(postings[0]?.raw).toMatchObject({ job_id: 'fixture-job-1' });
    });

    it('takes the location from job_city, else the part of job_location before the bullet', async () => {
      const { postings } = await build({ fetch: fakeFetch(ok).fetch }).fetch();
      expect(postings.map((p) => p.location)).toEqual([
        'Musterstadt',
        'Beispielburg',
        'Deutschland',
      ]);
    });

    it('takes the link of the apply option of the posting publisher, else the apply link, else the Google link', async () => {
      const { postings } = await build({ fetch: fakeFetch(ok).fetch }).fetch();
      expect(postings.map((p) => p.url)).toEqual([
        'https://de.linkedin.com/jobs/view/beispiel-stelle-a-at-beispiel-firma-a-1000000001',
        'https://de.indeed.example.invalid/viewjob?jk=0000000000000002',
        'https://www.google.com/search?q=fixture-job-3',
      ]);
    });

    it('takes the posted date from the timestamp when the date time is missing', async () => {
      const { postings } = await build({ fetch: fakeFetch(ok).fetch }).fetch();
      expect(postings[1]?.postedAt).toEqual(new Date(1783499400 * 1000));
    });

    it('counts a posting once when two searches return it', async () => {
      const { fetch } = fakeFetch(ok);
      const { postings } = await build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      }).fetch();
      expect(postings).toHaveLength(3);
    });
  });

  describe('requests', () => {
    it('sends the key header, query, country, posted within a week and a timeout, one page', async () => {
      const { fetch, calls } = fakeFetch(ok);
      await build({ fetch }).fetch();
      expect(calls).toHaveLength(1);
      const { url, key, signal } = calls[0] ?? {
        url: new URL('http://none.invalid'),
        key: null,
        signal: false,
      };
      expect(`${url.origin}${url.pathname}`).toBe('https://api.openwebninja.com/jsearch/search-v2');
      expect(key).toBe('test-key-1');
      expect(signal).toBe(true);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        query: 'koch in Musterstadt',
        country: 'de',
        date_posted: 'week',
      });
    });

    it('builds the query text from keyword and location, and sends the radius only with a location', async () => {
      const { fetch, calls } = fakeFetch(ok);
      await build({
        fetch,
        queries: () =>
          Promise.resolve([
            { keyword: 'koch', location: 'Musterstadt', radiusKm: 25 },
            { keyword: 'koch' },
            { location: 'Beispielburg', radiusKm: 0 },
          ]),
      }).fetch();
      expect(calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
        { query: 'koch in Musterstadt', country: 'de', date_posted: 'week', radius: '25' },
        { query: 'koch', country: 'de', date_posted: 'week' },
        { query: 'jobs in Beispielburg', country: 'de', date_posted: 'week', radius: '0' },
      ]);
    });

    it('sends the language only when it is configured, and the configured country', async () => {
      const { fetch, calls } = fakeFetch(ok);
      await build({ fetch, country: 'at', language: 'de' }).fetch();
      expect(calls[0]?.url.searchParams.get('language')).toBe('de');
      expect(calls[0]?.url.searchParams.get('country')).toBe('at');
    });

    it('runs every query once per publisher with the publisher appended, in order', async () => {
      const { fetch, calls } = fakeFetch(ok);
      await build({
        fetch,
        publishers: ['linkedin', 'indeed'],
        queries: () => Promise.resolve([{ keyword: 'koch' }, { location: 'Musterstadt' }]),
      }).fetch();
      expect(calls.map((c) => c.url.searchParams.get('query'))).toEqual([
        'koch via linkedin',
        'koch via indeed',
        'jobs in Musterstadt via linkedin',
        'jobs in Musterstadt via indeed',
      ]);
    });

    it('makes no request when there is no query', async () => {
      const { fetch, calls } = fakeFetch(ok);
      expect(await build({ fetch, queries: () => Promise.resolve([]) }).fetch()).toEqual({
        postings: [],
        errors: [],
      });
      expect(calls).toEqual([]);
    });

    it('reads the queries on every fetch', async () => {
      const { fetch, calls } = fakeFetch({ status: 200, body: emptyBody });
      let word = 'a';
      const source = build({ fetch, queries: () => Promise.resolve([{ keyword: word }]) });
      await source.fetch();
      word = 'b';
      await source.fetch();
      expect(calls.map((c) => c.url.searchParams.get('query'))).toEqual(['a', 'b']);
    });
  });

  describe('key switching', () => {
    it.each([429, 401, 403])(
      'retries the request on the next key after HTTP %i',
      async (status) => {
        const { fetch, calls } = fakeFetch(refused(status), ok);
        const { postings, errors } = await build({ fetch }).fetch();
        expect(calls.map((c) => c.key)).toEqual(['test-key-1', 'test-key-2']);
        expect(calls[1]?.url.href).toBe(calls[0]?.url.href);
        expect(postings).toHaveLength(3);
        expect(errors).toHaveLength(1); // only the result without a job id
      },
    );

    it('skips a refused key for the rest of the fetch and the next search goes on from where the last one ended', async () => {
      const { fetch, calls } = fakeFetch(refused(429), ok);
      await build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }, { keyword: 'c' }]),
      }).fetch();
      // a: key 1 refused, key 2 works. b: the rotation would reach key 1, which stays skipped, so key 2. c: key 2.
      expect(calls.map((c) => c.key)).toEqual([
        'test-key-1',
        'test-key-2',
        'test-key-2',
        'test-key-2',
      ]);
    });

    it('clears the unusable keys at the start of each fetch', async () => {
      // Run 1: both keys refuse. Run 2 starts after key 2, so key 1 is tried again: it refuses, key 2 works.
      const { fetch, calls } = fakeFetch(refused(429), refused(429), refused(429), ok);
      const source = build({ fetch });
      await expect(source.fetch()).rejects.toThrow();
      const { postings } = await source.fetch();
      expect(calls.map((c) => c.key)).toEqual([
        'test-key-1',
        'test-key-2',
        'test-key-1',
        'test-key-2',
      ]);
      expect(postings).toHaveLength(3);
    });

    it('fails the run at once when every key is refused, without naming a key', async () => {
      const { fetch, calls } = fakeFetch(refused(429));
      const source = build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }, { keyword: 'c' }]),
      });
      const failure = await source.fetch().then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/every API key/);
      expect(String(failure)).not.toMatch(/test-key/);
      expect(calls).toHaveLength(2); // one request per key, then the run stops
    });

    it('does not switch keys for other statuses', async () => {
      const { fetch, calls } = fakeFetch(refused(500), ok);
      const { errors } = await build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      }).fetch();
      expect(calls.map((c) => c.key)).toEqual(['test-key-1', 'test-key-2']);
      expect(errors[0]).toBe('search 1 failed: HTTP 500');
    });
  });

  describe('posted date', () => {
    it('drops an unparseable date time and falls back to the timestamp, keeping the posting', async () => {
      const body = {
        data: {
          jobs: [
            {
              job_id: 'fixture-bad-date',
              job_title: 'Beispiel Stelle',
              job_google_link: 'https://www.google.com/search?q=x',
              job_posted_at_datetime_utc: 'not-a-date',
              job_posted_at_timestamp: 1783499400,
            },
            {
              job_id: 'fixture-no-date',
              job_title: 'Beispiel Stelle 2',
              job_google_link: 'https://www.google.com/search?q=y',
              job_posted_at_datetime_utc: 'not-a-date',
            },
          ],
        },
      };
      const { postings, errors } = await build({
        fetch: fakeFetch({ status: 200, body }).fetch,
      }).fetch();
      expect(errors).toEqual([]);
      expect(postings.map((p) => p.postedAt)).toEqual([new Date(1783499400 * 1000), undefined]);
    });
  });

  describe('stats', () => {
    it('counts the requests sent per API and key position from 1, never the key', async () => {
      const { fetch } = fakeFetch(refused(429), ok);
      const source = build({ fetch, publishers: ['linkedin'] });
      expect(source.stats()).toEqual({
        requests: 0,
        slots: [
          { api: 'jsearch', keyPosition: 1, requests: 0 },
          { api: 'jsearch', keyPosition: 2, requests: 0 },
          { api: 'linkedin', keyPosition: 1, requests: 0 },
          { api: 'linkedin', keyPosition: 2, requests: 0 },
        ],
      });
      await source.fetch();
      expect(source.stats().requests).toBe(2);
      expect(source.stats().slots.map((s) => s.requests)).toEqual([1, 1, 0, 0]);
    });
  });

  describe('failures', () => {
    it('keeps the results of the searches that worked and numbers the one that failed', async () => {
      const { fetch } = fakeFetch(ok, refused(500));
      const { postings, errors } = await build({
        fetch,
        queries: () =>
          Promise.resolve([{ keyword: 'secret query a' }, { keyword: 'secret query b' }]),
      }).fetch();
      expect(postings).toHaveLength(3);
      expect(errors).toEqual([
        'result without job_id: Beispiel Stelle ohne Kennung',
        'search 2 failed: HTTP 500',
      ]);
    });

    it('fails the run when every search fails', async () => {
      const source = build({
        fetch: fakeFetch(refused(503)).fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      });
      await expect(source.fetch()).rejects.toThrow('search 1 failed: HTTP 503');
    });

    it('reports a body that is not the expected shape as a failed search', async () => {
      const { fetch } = fakeFetch(ok, { status: 200, body: { data: { jobs: 'nope' } } });
      const { errors } = await build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      }).fetch();
      expect(errors).toHaveLength(2); // the unusable result line, then the failed second search
      expect(errors[1]).toMatch(/^search 2 failed: /);
    });

    it('gives a fixed reason for a failure that is not an HTTP status, never the error text', async () => {
      const failing = (name: string, message: string) =>
        (() =>
          Promise.reject(Object.assign(new Error(message), { name }))) as unknown as typeof fetch;
      const lines = async (first: typeof fetch): Promise<string[]> => {
        let n = 0;
        const fetchImpl = ((...args: Parameters<typeof fetch>) => {
          n += 1;
          return n === 1
            ? first(...args)
            : Promise.resolve(new Response(JSON.stringify(emptyBody)));
        }) as typeof fetch;
        const { errors } = await build({
          fetch: fetchImpl,
          queries: () => Promise.resolve([{ keyword: 'secret query' }, { keyword: 'b' }]),
        }).fetch();
        return errors;
      };
      expect(
        await lines(failing('TypeError', 'fetch failed for https://x.invalid/?query=secret+query')),
      ).toEqual(['search 1 failed: network error']);
      expect(
        await lines(failing('TimeoutError', 'The operation was aborted due to timeout')),
      ).toEqual(['search 1 failed: timeout']);
    });

    it('never puts a key in an error line, even when the network error names it', async () => {
      let n = 0;
      const leaky = (() => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error('connect failed for x-api-key test-key-1'))
          : Promise.resolve(new Response(JSON.stringify(emptyBody)));
      }) as unknown as typeof fetch;
      const { errors } = await build({
        fetch: leaky,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      }).fetch();
      expect(errors).toEqual(['search 1 failed: network error']);
      expect(errors.join('\n')).not.toContain('test-key');
    });
  });
});

const slotsOf = (calls: Call[]): string[] => calls.map((c) => `${c.api}:${c.key ?? ''}`);
const letters = (n: number): { keyword: string }[] =>
  ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n).map((keyword) => ({ keyword }));

describe('round robin over the slots of a pool', () => {
  it('rotates a linkedin search over jsearch key 1 and 2, then linkedin key 1 and 2, and around', async () => {
    const { fetch, calls } = fakeFetch(ok);
    await build({
      fetch,
      publishers: ['linkedin'],
      queries: () => Promise.resolve(letters(5)),
    }).fetch();
    expect(slotsOf(calls)).toEqual([
      'jsearch:test-key-1',
      'jsearch:test-key-2',
      'linkedin:test-key-1',
      'linkedin:test-key-2',
      'jsearch:test-key-1',
    ]);
  });

  it('keeps one position per pool: the linkedin searches never move the indeed position', async () => {
    const { fetch, calls } = fakeFetch(ok);
    await build({
      fetch,
      publishers: ['linkedin', 'indeed'],
      queries: () => Promise.resolve(letters(2)),
    }).fetch();
    expect(slotsOf(calls)).toEqual([
      'jsearch:test-key-1', // a via linkedin
      'jsearch:test-key-1', // a via indeed
      'jsearch:test-key-2', // b via linkedin
      'jsearch:test-key-2', // b via indeed
    ]);
  });

  it('continues across fetches and after a new Source is built, from the request log', async () => {
    const requestLog = memoryLog();
    const over = {
      requestLog,
      publishers: ['linkedin'],
      queries: () => Promise.resolve(letters(3)),
    };
    const first = fakeFetch(ok);
    await build({ fetch: first.fetch, ...over }).fetch();
    const second = fakeFetch(ok);
    await build({ fetch: second.fetch, ...over }).fetch();
    expect(slotsOf(first.calls)).toEqual([
      'jsearch:test-key-1',
      'jsearch:test-key-2',
      'linkedin:test-key-1',
    ]);
    expect(slotsOf(second.calls)).toEqual([
      'linkedin:test-key-2',
      'jsearch:test-key-1',
      'jsearch:test-key-2',
    ]);
  });

  it('uses only the jsearch slots for any other publisher and for no publisher', async () => {
    for (const publishers of [[], ['glassdoor']]) {
      const { fetch, calls } = fakeFetch(ok);
      await build({ fetch, publishers, queries: () => Promise.resolve(letters(4)) }).fetch();
      expect(slotsOf(calls)).toEqual([
        'jsearch:test-key-1',
        'jsearch:test-key-2',
        'jsearch:test-key-1',
        'jsearch:test-key-2',
      ]);
    }
  });

  it('skips a refused slot for the rest of the fetch, whichever pool asks', async () => {
    const { fetch, calls } = fakeFetch(refused(429), ok);
    await build({
      fetch,
      publishers: ['linkedin', 'indeed'],
      queries: () => Promise.resolve(letters(2)),
    }).fetch();
    expect(slotsOf(calls)).toEqual([
      'jsearch:test-key-1', // a via linkedin: refused
      'jsearch:test-key-2', // a via linkedin: works
      'jsearch:test-key-2', // a via indeed: starts at jsearch key 1, which stays skipped
      'linkedin:test-key-1', // b via linkedin: after jsearch key 2
      'indeed:test-key-1', // b via indeed: after jsearch key 2
    ]);
  });

  it('fails the run when every slot of the pool is refused, naming no key', async () => {
    const { fetch, calls } = fakeFetch(refused(403));
    const failure = await build({ fetch, publishers: ['linkedin'] })
      .fetch()
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(String(failure)).toMatch(/every API key/);
    expect(String(failure)).not.toMatch(/test-key/);
    expect(slotsOf(calls)).toEqual([
      'jsearch:test-key-1',
      'jsearch:test-key-2',
      'linkedin:test-key-1',
      'linkedin:test-key-2',
    ]);
  });
});

describe('the dedicated APIs', () => {
  const endpoint = (call: Call | undefined): string =>
    call === undefined ? '' : call.url.origin + call.url.pathname;
  /** The log says the pool last used jsearch key 2, so the first search goes to the dedicated API. */
  async function onDedicated(
    publisher: 'linkedin' | 'indeed',
    queries: JsearchOptions['queries'],
    over: Partial<JsearchOptions> = {},
  ): Promise<{ calls: Call[]; result: Awaited<ReturnType<ReturnType<typeof build>['fetch']>> }> {
    const requestLog = memoryLog();
    await requestLog.record({
      api: 'jsearch',
      keyPosition: 2,
      publisher,
      query: 'seed',
      status: 200,
      failure: null,
      jobsReturned: 0,
    });
    const { fetch, calls } = fakeFetch(ok);
    const result = await build({
      fetch,
      requestLog,
      publishers: [publisher],
      queries,
      ...over,
    }).fetch();
    return { calls, result };
  }
  const koch = (): ReturnType<JsearchOptions['queries']> =>
    Promise.resolve([{ keyword: 'koch', location: 'Musterstadt', radiusKm: 25 }]);
  const params = (call: Call | undefined): Record<string, string> =>
    Object.fromEntries(call?.url.searchParams ?? []);

  it('sends a LinkedIn search with the keyword, place and country name, a week, never a radius or language', async () => {
    const { calls } = await onDedicated('linkedin', koch, { language: 'de' });
    expect(calls).toHaveLength(1);
    expect(endpoint(calls[0])).toBe('https://api.openwebninja.com/realtime-linkedin-data/search');
    expect(calls[0]?.key).toBe('test-key-1');
    expect(params(calls[0])).toEqual({
      query: 'koch',
      location: 'Musterstadt, Germany',
      date_posted: 'week',
    });
  });

  it('searches LinkedIn for jobs in the country alone when the pair has no keyword or no location', async () => {
    const noKeyword = await onDedicated(
      'linkedin',
      () => Promise.resolve([{ location: 'Musterstadt' }]),
      { country: 'at' },
    );
    expect(params(noKeyword.calls[0])).toMatchObject({
      query: 'jobs',
      location: 'Musterstadt, Austria',
    });
    const noLocation = await onDedicated('linkedin', () => Promise.resolve([{ keyword: 'koch' }]));
    expect(params(noLocation.calls[0])).toEqual({
      query: 'koch',
      location: 'Germany',
      date_posted: 'week',
    });
  });

  it('sends an Indeed search with the country, the optional language, and the radius only with a location', async () => {
    const full = await onDedicated('indeed', koch, { language: 'de' });
    expect(endpoint(full.calls[0])).toBe(
      'https://api.openwebninja.com/realtime-indeed-data/search',
    );
    expect(params(full.calls[0])).toEqual({
      query: 'koch',
      location: 'Musterstadt',
      country: 'de',
      language: 'de',
      radius: '25',
      date_posted: 'week',
    });
    const noLocation = await onDedicated('indeed', () =>
      Promise.resolve([{ keyword: 'koch', radiusKm: 25 }]),
    );
    expect(params(noLocation.calls[0])).toEqual({
      query: 'koch',
      country: 'de',
      date_posted: 'week',
    });
    const zero = await onDedicated('indeed', () =>
      Promise.resolve([{ location: 'Musterstadt', radiusKm: 0 }]),
    );
    expect(params(zero.calls[0])).toEqual({
      query: 'jobs',
      location: 'Musterstadt',
      country: 'de',
      radius: '0',
      date_posted: 'week',
    });
  });

  it('reads a LinkedIn result into a posting with the id, link and publisher of the site, and reports a result without job_uid', async () => {
    const { result } = await onDedicated('linkedin', koch);
    expect(result.errors).toEqual(['result without job_uid: Beispiel Stelle ohne Kennung']);
    expect(result.postings.map((p) => [p.sourcePostingId, p.url, p.publisher])).toEqual([
      ['linkedin:1000000001', 'https://www.linkedin.com/jobs/view/1000000001', 'LinkedIn'],
      ['linkedin:1000000002', 'https://www.linkedin.com/jobs/view/1000000002', 'LinkedIn'],
    ]);
    expect(result.postings[0]).toMatchObject({
      title: 'Beispiel Stelle L1 (m/w/d)',
      company: 'Beispiel Firma L',
      location: 'Musterstadt',
      postedAt: new Date('2026-07-09T08:30:00.000Z'),
    });
    expect(result.postings[1]).toMatchObject({
      location: 'Beispielburg, Deutschland',
      postedAt: new Date(1783499400 * 1000),
    });
  });

  it('reads an Indeed result into a posting on the country site, whatever publisher the result names', async () => {
    const { result } = await onDedicated('indeed', koch);
    expect(result.errors).toEqual(['result without job_uid: Beispiel Stelle I ohne Kennung']);
    expect(result.postings.map((p) => [p.sourcePostingId, p.url, p.publisher])).toEqual([
      ['indeed:00000000000000a1', 'https://de.indeed.com/viewjob?jk=00000000000000a1', 'Indeed'],
      ['indeed:00000000000000a2', 'https://de.indeed.com/viewjob?jk=00000000000000a2', 'Indeed'],
    ]);
    const us = await onDedicated('indeed', koch, { country: 'us' });
    expect(us.result.postings[0]?.url).toBe('https://www.indeed.com/viewjob?jk=00000000000000a1');
  });
});

describe('request log', () => {
  it('writes one row per request with the API, key position, publisher, query, status and jobs returned', async () => {
    const requestLog = memoryLog();
    const { fetch } = fakeFetch(refused(429), ok);
    await build({ fetch, requestLog, publishers: ['linkedin'] }).fetch();
    expect(requestLog.entries).toEqual([
      {
        api: 'jsearch',
        keyPosition: 1,
        publisher: 'linkedin',
        query: 'koch in Musterstadt via linkedin',
        status: 429,
        failure: null,
        jobsReturned: 0,
      },
      {
        api: 'jsearch',
        keyPosition: 2,
        publisher: 'linkedin',
        query: 'koch in Musterstadt via linkedin',
        status: 200,
        failure: null,
        jobsReturned: 4,
      },
    ]);
  });

  it('logs a null publisher for a search without one, and the dedicated API row with its own query text', async () => {
    const requestLog = memoryLog();
    const { fetch } = fakeFetch(ok);
    await build({ fetch, requestLog, publishers: [] }).fetch();
    expect(requestLog.entries[0]?.publisher).toBeNull();
    const dedicatedLog = memoryLog();
    await dedicatedLog.record({
      api: 'jsearch',
      keyPosition: 2,
      publisher: 'indeed',
      query: 'seed',
      status: 200,
      failure: null,
      jobsReturned: 0,
    });
    await build({
      fetch: fakeFetch(ok).fetch,
      requestLog: dedicatedLog,
      publishers: ['indeed'],
    }).fetch();
    expect(dedicatedLog.entries[1]).toMatchObject({
      api: 'indeed',
      keyPosition: 1,
      query: 'koch',
      jobsReturned: 3,
      status: 200,
    });
  });

  it('logs a fixed reason for a failure that has no status, and never a key or an error text', async () => {
    const requestLog = memoryLog();
    let n = 0;
    const flaky = (() => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('connect failed for x-api-key test-key-1'));
      if (n === 2)
        return Promise.reject(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
      return Promise.resolve(new Response('not json', { status: 200 }));
    }) as unknown as typeof fetch;
    await build({
      fetch: flaky,
      requestLog,
      queries: () => Promise.resolve(letters(3)),
    })
      .fetch()
      .catch(() => undefined);
    expect(requestLog.entries.map((e) => [e.status, e.failure, e.jobsReturned])).toEqual([
      [null, 'network error', 0],
      [null, 'timeout', 0],
      [200, 'unusable response', 0],
    ]);
    expect(JSON.stringify(requestLog.entries)).not.toContain('test-key');
  });

  it('fails the run, not one search, when the log cannot be written', async () => {
    const requestLog: RequestLog = {
      record: () => Promise.reject(new Error('database is down')),
      lastSlot: () => Promise.resolve(null),
    };
    await expect(
      build({
        fetch: fakeFetch(ok).fetch,
        requestLog,
        queries: () => Promise.resolve(letters(2)),
      }).fetch(),
    ).rejects.toThrow('database is down');
  });
});
