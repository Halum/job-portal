import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { fekiAdapter, parseFekiHtml, parseRelativeGerman } from '../src/feki.js';
import { getAdapter } from '../src/index.js';

// Saved from https://bambase.de/jobs on 2026-11-06 (feki.de Jobbörse moved there).
const html = readFileSync(
  fileURLToPath(new URL('./fixtures/feki/jobs.html', import.meta.url)),
  'utf8',
);
const NOW = new Date('2026-11-06T12:00:00Z');

describe('parseFekiHtml (real bambase fixture)', () => {
  const jobs = parseFekiHtml(html, NOW);

  it('extracts all 12 listings on the page and skips /job/new', () => {
    expect(jobs.length).toBe(12);
    expect(jobs.some((j) => j.externalId === 'new')).toBe(false);
  });

  it('uses the slug as externalId and reads company/location', () => {
    const j = jobs.find((x) => x.externalId === 'aushilfe-fuer-augenarztpraxis-bamberg-innenstadt');
    expect(j).toBeDefined();
    expect(j!.title).toBe('Aushilfe für Augenarztpraxis Bamberg-Innenstadt');
    expect(j!.company).toBe('Augenarztpraxis Dr. Knorr');
    expect(j!.location).toBe('Bamberg');
    expect(j!.applyUrl).toBe(
      'https://bambase.de/job/aushilfe-fuer-augenarztpraxis-bamberg-innenstadt',
    );
    // "vor 17 Stunden"
    expect(j!.postedAt?.toISOString()).toBe('2026-11-05T19:00:00.000Z');
  });

  it('every job has a stable id, title, applyUrl and postedAt', () => {
    for (const j of jobs) {
      expect(j.externalId).toMatch(/^[a-z0-9-]+$/);
      expect(j.title.length).toBeGreaterThan(0);
      expect(j.applyUrl.startsWith('https://bambase.de/job/')).toBe(true);
      expect(j.postedAt).toBeInstanceOf(Date);
    }
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
    expect(NOW.getTime() - parseRelativeGerman(text, NOW)!.getTime()).toBe(ms);
  });

  it('returns undefined for unknown text', () => {
    expect(parseRelativeGerman('gerade eben', NOW)).toBeUndefined();
  });
});

describe('getAdapter', () => {
  it('returns the matching adapter', () => {
    expect(getAdapter('feki').sourceType).toBe('feki');
    expect(getAdapter('arbeitsagentur').sourceType).toBe('arbeitsagentur');
  });
});

function mock(path: string, status: number, body: string) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://bambase.de').intercept({ path, method: 'GET' }).reply(status, body);
}

describe('fekiAdapter.fetch (mocked HTTP)', () => {
  afterEach(() => setGlobalDispatcher(new MockAgent()));

  it('fetches and parses', async () => {
    mock('/jobs', 200, html);
    expect((await fekiAdapter.fetch('https://bambase.de/jobs')).length).toBe(12);
  });

  it('throws on non-2xx', async () => {
    mock('/jobs', 500, '');
    await expect(fekiAdapter.fetch('https://bambase.de/jobs')).rejects.toThrow(/HTTP 500/);
  });
});

describe('fekiAdapter.fetchDescription (mocked HTTP)', () => {
  afterEach(() => setGlobalDispatcher(new MockAgent()));

  it('extracts and whitespace-collapses the description text', async () => {
    mock(
      '/job/x',
      200,
      `<html><body><main><div class="prose"><p class="whitespace-pre-wrap">
        Line one.
        Line   two.
      </p></div></main></body></html>`,
    );
    const description = await fekiAdapter.fetchDescription({
      externalId: 'x',
      applyUrl: 'https://bambase.de/job/x',
    });
    expect(description).toBe('Line one. Line two.');
  });

  it('throws on non-2xx', async () => {
    mock('/job/y', 500, '');
    await expect(
      fekiAdapter.fetchDescription({ externalId: 'y', applyUrl: 'https://bambase.de/job/y' }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
