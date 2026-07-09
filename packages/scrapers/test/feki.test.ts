import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { fekiAdapter, parseFekiHtml } from '../src/feki.js';
import { getAdapter } from '../src/index.js';

const html = readFileSync(
  fileURLToPath(new URL('./fixtures/feki/jobboerse.html', import.meta.url)),
  'utf8',
);

describe('parseFekiHtml (real fixture)', () => {
  const jobs = parseFekiHtml(html);

  it('extracts all listings on the page', () => {
    expect(jobs.length).toBe(10);
  });

  it('derives numeric externalId from the detail slug', () => {
    const j = jobs.find((x) => x.externalId === '38526');
    expect(j).toBeDefined();
    expect(j!.title).toContain('Fahrradkurier');
    expect(j!.company).toBe('Labor Becker MVZ eGbR');
    expect(j!.location).toBe('Bamberg');
    expect(j!.applyUrl).toBe(
      'https://www.feki.de/jobboerse/details/38526-Fahrradkurier-/-Medizinischer-Probenfahrer-%28m/w/d%29-%E2%80%93-Minijob-im-Herzen-von-Bamberg',
    );
    expect(j!.postedAt?.getFullYear()).toBe(2026);
  });

  it('every job has a stable id, title, applyUrl and description', () => {
    for (const j of jobs) {
      expect(j.externalId).toMatch(/^\d+$/);
      expect(j.title.length).toBeGreaterThan(0);
      expect(j.applyUrl.startsWith('https://www.feki.de/')).toBe(true);
      expect(j.description.length).toBeGreaterThan(0);
    }
  });
});

describe('getAdapter', () => {
  it('returns the matching adapter', () => {
    expect(getAdapter('feki').sourceType).toBe('feki');
    expect(getAdapter('arbeitsagentur').sourceType).toBe('arbeitsagentur');
  });
});

describe('fekiAdapter.fetch (mocked HTTP)', () => {
  afterEach(() => setGlobalDispatcher(new MockAgent()));

  it('fetches and parses', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get('https://www.feki.de')
      .intercept({ path: '/jobboerse', method: 'GET' })
      .reply(200, html);

    const jobs = await fekiAdapter.fetch('https://www.feki.de/jobboerse');
    expect(jobs.length).toBe(10);
  });

  it('throws on non-2xx', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get('https://www.feki.de')
      .intercept({ path: '/jobboerse', method: 'GET' })
      .reply(500, '');

    await expect(fekiAdapter.fetch('https://www.feki.de/jobboerse')).rejects.toThrow(/HTTP 500/);
  });
});
