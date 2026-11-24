import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundesagenturQuery, createBundesagenturSource } from './bundesagentur';

interface Entry {
  referenznummer: string;
  stellenangebotsTitel: string;
  firma: string;
  stellenlokationen: { adresse: { ort: string } }[];
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/bundesagentur-search.json', import.meta.url), 'utf8'),
) as { ergebnisliste: Entry[] };

function fakeFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; calls: { url: string; key: string | null; signal: boolean }[] } {
  const calls: { url: string; key: string | null; signal: boolean }[] = [];
  const fakeImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      signal: init?.signal != null,
      url,
      key: new Headers(init?.headers).get('X-API-Key'),
    });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch: fakeImpl, calls };
}

describe('bundesagentur source', () => {
  it('normalizes every recorded result, using referenznummer as the source posting id', async () => {
    const { fetch, calls } = fakeFetch(200, fixture);
    const source = createBundesagenturSource({ query: 'wo=Musterstadt&umkreis=7', fetch });

    const { postings, errors } = await source.fetch();

    expect(source.id).toBe('bundesagentur');
    expect(errors).toEqual([]);
    expect(postings).toHaveLength(5);
    expect(postings[0]).toMatchObject({
      sourcePostingId: '10000-0000000001-S',
      title: 'Personalsachbearbeiter (m/w/d)',
      company: 'Beispiel Firma A',
      location: 'Musterstadt',
      url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-0000000001-S',
    });
    expect(postings[0]?.postedAt).toEqual(new Date('2026-07-09'));
    expect(postings[0]?.raw).toEqual(fixture.ergebnisliste[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(true); // outbound requests carry a timeout
    expect(calls[0]?.key).toBe('jobboerse-jobsuche');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('wo')).toBe('Musterstadt');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('umkreis')).toBe('7');
  });

  it('passes only known query parameters to the API', async () => {
    const { fetch, calls } = fakeFetch(200, { ergebnisliste: [] });
    await createBundesagenturSource({ query: 'wo=Musterstadt&evil=1', fetch }).fetch();
    const params = new URL(calls[0]?.url ?? '').searchParams;
    expect(params.has('wo')).toBe(true);
    expect(params.has('evil')).toBe(false);
  });

  it('reports a result without referenznummer as an error and keeps the rest', async () => {
    const body = { ergebnisliste: [{ stellenangebotsTitel: 'no id' }, fixture.ergebnisliste[0]] };
    const { postings, errors } = await createBundesagenturSource({
      query: '',
      fetch: fakeFetch(200, body).fetch,
    }).fetch();
    expect(postings).toHaveLength(1);
    expect(errors).toEqual(['result without referenznummer: no id']);
  });

  it('tolerates a missing ergebnisliste', async () => {
    const { postings } = await createBundesagenturSource({
      query: '',
      fetch: fakeFetch(200, {}).fetch,
    }).fetch();
    expect(postings).toEqual([]);
  });

  it('throws on a non-2xx response', async () => {
    const source = createBundesagenturSource({ query: '', fetch: fakeFetch(503, {}).fetch });
    await expect(source.fetch()).rejects.toThrow(/HTTP 503/);
  });

  it('throws on a body that is not the expected shape', async () => {
    const source = createBundesagenturSource({
      query: '',
      fetch: fakeFetch(200, { ergebnisliste: 'nope' }).fetch,
    });
    await expect(source.fetch()).rejects.toThrow();
  });

  it('fetches a description from the base64 detail path', async () => {
    const id = '10000-0000000001-S';
    const { fetch, calls } = fakeFetch(200, { stellenangebotsBeschreibung: 'Full text.' });
    const source = createBundesagenturSource({ query: '', fetch });
    expect(await source.fetchDescription?.({ sourcePostingId: id })).toBe('Full text.');
    expect(calls[0]?.url).toContain(`/jobdetails/${Buffer.from(id).toString('base64')}`);
  });

  it('throws on a non-2xx description response', async () => {
    const source = createBundesagenturSource({ query: '', fetch: fakeFetch(403, {}).fetch });
    await expect(source.fetchDescription?.({ sourcePostingId: 'x' })).rejects.toThrow(/HTTP 403/);
  });

  describe('searches from Targets', () => {
    const search =
      (urls: string[]): ((u: string) => Promise<Response>) =>
      (u) => {
        urls.push(u);
        return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
      };

    it('runs one request per query, passes was, wo and umkreis, and merges equal postings', async () => {
      const urls: string[] = [];
      const source = createBundesagenturSource({
        queries: () =>
          Promise.resolve([
            bundesagenturQuery({ was: 'koch', wo: 'Musterstadt', umkreis: 0 }),
            bundesagenturQuery({ was: 'beispiel', wo: 'Musterstadt' }),
          ]),
        fetch: search(urls) as unknown as typeof fetch,
      });
      const { postings, errors } = await source.fetch();
      expect(urls).toHaveLength(2);
      const first = new URL(urls[0] ?? '').searchParams;
      expect([first.get('was'), first.get('wo'), first.get('umkreis')]).toEqual([
        'koch',
        'Musterstadt',
        '0',
      ]);
      expect(new URL(urls[1] ?? '').searchParams.has('umkreis')).toBe(false);
      expect(postings).toHaveLength(5); // the same five postings from both searches count once
      expect(errors).toEqual([]);
    });

    it('makes no request when there is no query', async () => {
      const urls: string[] = [];
      const source = createBundesagenturSource({
        queries: () => Promise.resolve([]),
        fetch: search(urls) as unknown as typeof fetch,
      });
      expect(await source.fetch()).toEqual({ postings: [], errors: [] });
      expect(urls).toEqual([]);
    });

    it('keeps the results of the searches that worked and reports the one that failed', async () => {
      let n = 0;
      const flaky = (() => {
        n += 1;
        return Promise.resolve(
          n === 1 ? new Response('no', { status: 500 }) : new Response(JSON.stringify(fixture)),
        );
      }) as unknown as typeof fetch;
      const source = createBundesagenturSource({
        queries: () => Promise.resolve(['was=a', 'was=b']),
        fetch: flaky,
      });
      const { postings, errors } = await source.fetch();
      expect(postings).toHaveLength(5);
      expect(errors).toEqual(['search failed: bundesagentur API returned HTTP 500']);
    });

    it('fails the run when every search fails', async () => {
      const source = createBundesagenturSource({
        queries: () => Promise.resolve(['was=a', 'was=b']),
        fetch: fakeFetch(503, {}).fetch,
      });
      await expect(source.fetch()).rejects.toThrow(/HTTP 503/);
    });

    it('builds the query string from Matching parameters', () => {
      expect(bundesagenturQuery({})).toBe('');
      expect(bundesagenturQuery({ was: 'Alpha & Küche', wo: '50667', umkreis: 7 })).toBe(
        'was=Alpha+%26+K%C3%BCche&wo=50667&umkreis=7',
      );
    });
  });
});
