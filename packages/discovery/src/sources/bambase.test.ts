import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAMBASE, createBambaseSource, parseRelativeGerman } from './bambase';

const fixture = readFileSync(new URL('./fixtures/bambase-jobs.html', import.meta.url), 'utf8');
const NOW = new Date('2026-11-06T12:00:00Z');

interface Call {
  url: string;
  signal: boolean;
}
function fakeFetch(status: number, body: string): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fakeImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, signal: init?.signal != null });
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetch: fakeImpl, calls };
}
const source = (status = 200, body = fixture): ReturnType<typeof makeSource> =>
  makeSource(fakeFetch(status, body));
function makeSource(f: ReturnType<typeof fakeFetch>): {
  source: ReturnType<typeof createBambaseSource>;
  calls: Call[];
} {
  return { source: createBambaseSource({ fetch: f.fetch, now: () => NOW }), calls: f.calls };
}

describe('bambase source', () => {
  it('normalizes every listing on the recorded page and skips the post-a-job link', async () => {
    const { source: s, calls } = source();

    const { postings, errors } = await s.fetch();

    expect(s.id).toBe(BAMBASE);
    expect(errors).toEqual([]);
    expect(postings).toHaveLength(12);
    expect(postings.some((p) => p.sourcePostingId === 'new')).toBe(false);
    expect(postings[0]).toMatchObject({
      sourcePostingId: 'beispiel-stelle-1',
      title: 'Beispiel Stelle 1 (m/w/d)',
      company: 'Beispiel Firma A',
      location: 'Musterstadt',
      url: 'https://bambase.de/job/beispiel-stelle-1',
    });
    expect(postings[0]?.postedAt?.toISOString()).toBe('2026-11-05T19:00:00.000Z'); // "vor 17 Stunden"
    expect(postings[0]?.raw).toMatchObject({
      href: '/job/beispiel-stelle-1',
      type: 'Nebenjob',
      age: 'vor 17 Stunden',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: 'https://bambase.de/jobs', signal: true }); // fixed host, with a timeout
  });

  it('reports a listing without a title as an error and keeps the rest', async () => {
    const html = `<a href="/job/no-title"><p>x</p></a>${fixture}`;
    const { postings, errors } = await source(200, html).source.fetch();
    expect(postings).toHaveLength(12);
    expect(errors).toEqual(['listing without a title: no-title']);
  });

  it('throws on a non-2xx response', async () => {
    await expect(source(500, '').source.fetch()).rejects.toThrow(/HTTP 500/);
  });

  it('reads the description of one posting from its detail page', async () => {
    const page = `<main><div class="prose"><p>
      Line one.
      Line   two.
    </p></div></main>`;
    const { source: s, calls } = source(200, page);
    expect(await s.fetchDescription?.({ sourcePostingId: 'beispiel-stelle-1' })).toBe(
      'Line one. Line two.',
    );
    expect(calls[0]?.url).toBe('https://bambase.de/job/beispiel-stelle-1');
  });
});

describe('parseRelativeGerman', () => {
  it.each([
    ['vor 17 Stunden', 17 * 3_600_000],
    ['vor einem Tag', 86_400_000],
    ['vor 2 Tagen', 2 * 86_400_000],
    ['vor einer Stunde', 3_600_000],
    ['vor 5 Minuten', 5 * 60_000],
    ['vor 3 Wochen', 3 * 604_800_000],
  ])('%s', (text, ms) => {
    expect(NOW.getTime() - (parseRelativeGerman(text, NOW)?.getTime() ?? 0)).toBe(ms);
  });

  it('returns undefined for unknown text', () => {
    expect(parseRelativeGerman('gerade eben', NOW)).toBeUndefined();
  });
});
