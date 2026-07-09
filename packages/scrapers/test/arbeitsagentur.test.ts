import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  arbeitsagenturAdapter,
  buildApiParams,
  normalizeResponse,
} from '../src/arbeitsagentur.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/arbeitsagentur/bamberg.json', import.meta.url)), 'utf8'),
);

describe('buildApiParams', () => {
  it('translates human URL params to the REST schema, dropping unknowns', () => {
    const p = buildApiParams(
      'https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg&umkreis=25&angebotsart=1&sort=aktualitaet&irrelevant=x',
    );
    expect(p.get('wo')).toBe('Bamberg');
    expect(p.get('umkreis')).toBe('25');
    expect(p.get('angebotsart')).toBe('1');
    expect(p.get('sort')).toBe('aktualitaet');
    expect(p.has('irrelevant')).toBe(false);
  });
});

describe('normalizeResponse (real fixture)', () => {
  const jobs = normalizeResponse(fixture);

  it('normalizes every result with referenznummer as externalId', () => {
    expect(jobs.length).toBe(fixture.ergebnisliste.length);
    const first = fixture.ergebnisliste[0];
    const j = jobs[0]!;
    expect(j.externalId).toBe(first.referenznummer);
    expect(j.title).toBe(first.stellenangebotsTitel);
    expect(j.company).toBe(first.firma);
    expect(j.location).toBe(first.stellenlokationen[0].adresse.ort);
    expect(j.applyUrl).toContain(encodeURIComponent(first.referenznummer));
    expect(j.postedAt).toBeInstanceOf(Date);
    expect(j.raw).toBe(first);
  });

  it('skips results without a referenznummer', () => {
    const out = normalizeResponse({ ergebnisliste: [{ stellenangebotsTitel: 'no id' }] });
    expect(out).toEqual([]);
  });

  it('tolerates a missing ergebnisliste', () => {
    expect(normalizeResponse({})).toEqual([]);
  });
});

describe('arbeitsagenturAdapter.fetch (mocked HTTP)', () => {
  afterEach(() => setGlobalDispatcher(new MockAgent()));

  it('fetches, sends the API key, and normalizes', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get('https://rest.arbeitsagentur.de')
      .intercept({ path: /\/v6\/jobs/, method: 'GET' })
      .reply(200, fixture);

    const jobs = await arbeitsagenturAdapter.fetch(
      'https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg&umkreis=25',
    );
    expect(jobs.length).toBe(fixture.ergebnisliste.length);
  });

  it('throws on non-2xx', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get('https://rest.arbeitsagentur.de')
      .intercept({ path: /\/v6\/jobs/, method: 'GET' })
      .reply(503, '');

    await expect(
      arbeitsagenturAdapter.fetch('https://www.arbeitsagentur.de/jobsuche/suche?wo=Bamberg'),
    ).rejects.toThrow(/HTTP 503/);
  });
});
