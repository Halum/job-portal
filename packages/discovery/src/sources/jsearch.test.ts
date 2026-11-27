import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createJsearchSource, type JsearchOptions } from './jsearch';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/jsearch-search.json', import.meta.url), 'utf8'),
);
const emptyBody = { data: { jobs: [] } };

interface Call {
  url: URL;
  key: string | null;
  signal: boolean;
}

/** Answers each request from the next entry of `answers`, the last one repeating. Status 200 serves the body. */
function fakeFetch(...answers: { status: number; body?: unknown }[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url: new URL(href),
      key: new Headers(init?.headers).get('x-api-key'),
      signal: init?.signal != null,
    });
    const answer = answers[Math.min(calls.length, answers.length) - 1] ?? { status: 200 };
    return Promise.resolve(new Response(JSON.stringify(answer.body ?? fixture), answer));
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

    it('starts later requests and later runs on the key that worked', async () => {
      const { fetch, calls } = fakeFetch(refused(429), ok);
      const source = build({
        fetch,
        queries: () => Promise.resolve([{ keyword: 'a' }, { keyword: 'b' }]),
      });
      await source.fetch();
      await source.fetch();
      expect(calls.map((c) => c.key)).toEqual([
        'test-key-1',
        'test-key-2',
        'test-key-2',
        'test-key-2',
        'test-key-2',
      ]);
    });

    it('clears the unusable keys at the start of each fetch', async () => {
      // Run 1: both keys refuse. Run 2: key 2 (where run 1 ended) refuses, and key 1 is tried again and works.
      const { fetch, calls } = fakeFetch(refused(429), refused(429), refused(429), ok);
      const source = build({ fetch });
      await expect(source.fetch()).rejects.toThrow();
      const { postings } = await source.fetch();
      expect(calls.map((c) => c.key)).toEqual([
        'test-key-1',
        'test-key-2',
        'test-key-2',
        'test-key-1',
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
      expect(calls.map((c) => c.key)).toEqual(['test-key-1', 'test-key-1']);
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
    it('counts the requests sent and gives the position of the current key from 1', async () => {
      const { fetch } = fakeFetch(refused(429), ok);
      const source = build({ fetch });
      expect(source.stats()).toEqual({ requests: 0, keyPosition: 1 });
      await source.fetch();
      expect(source.stats()).toEqual({ requests: 2, keyPosition: 2 });
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
