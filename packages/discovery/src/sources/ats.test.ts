import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMemorySlots, createRateLimitedFetch } from '../rate-limit';
import { createAtsSource, fetchBoardPostings, type BoardRef } from './ats';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Serves recorded bodies by URL part; any other URL answers 404. */
function fakeFetch(routes: Record<string, string>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    expect(init?.signal).toBeDefined(); // outbound requests carry a timeout
    const hit = Object.entries(routes).find(([part]) => url.includes(part));
    return Promise.resolve(
      hit ? new Response(hit[1], { status: 200 }) : new Response('nope', { status: 404 }),
    );
  };
  return { fetch: impl, urls };
}

const board = (token: string, host?: string): BoardRef => ({ token, name: 'Beispiel Firma', host });

describe('greenhouse adapter', () => {
  it('normalizes jobs, skips ones without a link, and keeps the raw job', async () => {
    const { fetch, urls } = fakeFetch({ '/beispielfirma/jobs': fixture('greenhouse-board.json') });
    const postings = await fetchBoardPostings('greenhouse', board('beispielfirma'), fetch);
    expect(urls).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/beispielfirma/jobs?content=true',
    ]);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      sourcePostingId: 'beispielfirma/1000001',
      title: 'Backend Engineer (m/w/d)',
      company: 'Beispiel Firma A',
      location: 'Berlin, Germany',
      url: 'https://job-boards.greenhouse.io/beispielfirma/jobs/1000001',
    });
    expect(postings[0]?.postedAt).toEqual(new Date('2026-10-19T11:17:24-04:00'));
    expect(postings[1]?.postedAt).toEqual(new Date('2026-10-21T08:00:00-04:00')); // updated_at fallback
    expect(postings[0]?.raw).toMatchObject({ id: 1000001, internal_job_id: 2000001 });
  });
});

describe('lever adapter', () => {
  it('normalizes postings with all locations and country, and takes the company from the board', async () => {
    const { fetch, urls } = fakeFetch({ '/beispielfirma': fixture('lever-board.json') });
    const postings = await fetchBoardPostings('lever', board('beispielfirma'), fetch);
    expect(urls).toEqual([
      'https://api.lever.co/v0/postings/beispielfirma?mode=json&skip=0&limit=100',
    ]);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({
      sourcePostingId: 'beispielfirma/00000000-0000-4000-8000-000000000001',
      title: 'Werkstudent Marketing',
      company: 'Beispiel Firma',
      location: 'Munich, Remote - Europe, DE',
    });
    expect(postings[0]?.postedAt).toEqual(new Date(1790000000000));
    expect(postings[1]?.location).toBe('New York');
  });

  it('uses the EU host for an eu board', async () => {
    const { fetch, urls } = fakeFetch({ '/eu-board': '[]' });
    await fetchBoardPostings('lever', board('eu-board', 'eu'), fetch);
    expect(urls[0]).toContain('https://api.eu.lever.co/v0/postings/eu-board');
  });

  it('pages until a short page and stops when the board ignores skip', async () => {
    const posting = (id: string): object => ({
      id,
      text: 't',
      hostedUrl: `https://jobs.lever.co/x/${id}`,
    });
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => posting(`p${String(i)}`)));
    const last = JSON.stringify([posting('last')]);
    const calls: string[] = [];
    const paged = ((input: string) => {
      calls.push(input);
      return Promise.resolve(new Response(input.includes('skip=0') ? full : last));
    }) as unknown as typeof fetch;
    expect(await fetchBoardPostings('lever', board('big'), paged)).toHaveLength(101);
    expect(calls).toHaveLength(2);

    const stuck = (() => Promise.resolve(new Response(full))) as unknown as typeof fetch;
    expect(await fetchBoardPostings('lever', board('stuck'), stuck)).toHaveLength(100);
  });
});

describe('ashby adapter', () => {
  it('normalizes listed jobs, joins distinct locations, and skips unlisted jobs', async () => {
    const { fetch, urls } = fakeFetch({ '/beispielfirma': fixture('ashby-board.json') });
    const postings = await fetchBoardPostings('ashby', board('beispielfirma'), fetch);
    expect(urls).toEqual(['https://api.ashbyhq.com/posting-api/job-board/beispielfirma']);
    expect(postings.map((p) => p.title)).toEqual(['Engineering Manager', 'Office Manager']);
    expect(postings[0]).toMatchObject({
      sourcePostingId: 'beispielfirma/11111111-1111-4111-8111-111111111111',
      company: 'Beispiel Firma',
      location: 'Remote - European Union, Germany',
    });
    expect(postings[0]?.postedAt).toEqual(new Date('2026-10-01T09:00:00.000+00:00'));
  });
});

describe('createAtsSource', () => {
  it('fetches every listed board, and one failing board is an error line, not a failure', async () => {
    const { fetch } = fakeFetch({ '/good/jobs': fixture('greenhouse-board.json') });
    const source = createAtsSource('greenhouse', {
      listBoards: () => Promise.resolve([board('good'), board('gone')]),
      fetch,
    });
    const { postings, errors } = await source.fetch();
    expect(source.id).toBe('greenhouse');
    expect(postings).toHaveLength(2);
    expect(errors).toEqual(['greenhouse board gone: HTTP 404']);
  });

  it('never follows a redirect: the request asks for redirect "error"', async () => {
    let seen: RequestInit | undefined;
    const spy: typeof fetch = (_input, init) => {
      seen = init;
      return Promise.resolve(new Response(fixture('greenhouse-board.json')));
    };
    await fetchBoardPostings('greenhouse', board('good'), spy);
    expect(seen?.redirect).toBe('error');
  });

  it('reports a malformed body as an error of that board', async () => {
    const source = createAtsSource('ashby', {
      listBoards: () => Promise.resolve([board('bad')]),
      fetch: fakeFetch({ '/bad': '{"jobs":"nope"}' }).fetch,
    });
    expect((await source.fetch()).errors).toEqual(['ashby board bad: unexpected response shape']);
  });

  it('keeps requests per ATS host under the configured rate', async () => {
    let t = 0;
    const stamps: { host: string; at: number }[] = [];
    const inner: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      stamps.push({ host: new URL(url).host, at: t });
      return Promise.resolve(new Response(url.includes('lever') ? '[]' : '{"jobs":[]}'));
    };
    const limited = createRateLimitedFetch(2, inner, {
      slots: createMemorySlots(() => t),
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    });
    const boards = [board('a'), board('b'), board('c'), board('d')];
    for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
      await createAtsSource(ats, {
        listBoards: () => Promise.resolve(boards),
        fetch: limited,
      }).fetch();
    }
    for (const host of new Set(stamps.map((s) => s.host))) {
      const times = stamps.filter((s) => s.host === host).map((s) => s.at);
      expect(times).toHaveLength(4);
      for (let i = 2; i < times.length; i += 1) {
        // no third request inside one second of the request two before it
        expect((times[i] ?? 0) - (times[i - 2] ?? 0)).toBeGreaterThanOrEqual(1000);
      }
    }
  });
});
