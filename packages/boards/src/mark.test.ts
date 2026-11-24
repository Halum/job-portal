import { describe, expect, it } from 'vitest';
import { loadBundledBoards } from './data';
import type { Board, BoardDirectory } from './directory';
import { markBoards, postedInGermanyOrRemoteEu } from './mark';

describe('postedInGermanyOrRemoteEu', () => {
  it.each([
    ['Berlin, Germany'],
    ['Köln'],
    ['Remote - European Union'],
    ['EMEA (Remote)'],
    ['Remote, Europe'],
    ['Munich, Remote - Europe, DE'],
  ])('accepts %j', (location) => {
    expect(postedInGermanyOrRemoteEu([location])).toBe(true);
  });

  it.each([
    ['San Francisco, CA'],
    ['Remote - US'],
    ['Remote'],
    ['London, UK'],
    ['Mumbai, IN'],
    [''],
  ])('rejects %j', (location) => {
    expect(postedInGermanyOrRemoteEu([location])).toBe(false);
  });

  it('accepts when any one location fits and ignores missing ones', () => {
    expect(postedInGermanyOrRemoteEu([undefined, 'Austin, TX', 'Hamburg'])).toBe(true);
    expect(postedInGermanyOrRemoteEu([undefined])).toBe(false);
    expect(postedInGermanyOrRemoteEu([])).toBe(false);
  });
});

describe('markBoards', () => {
  const board = (token: string): Board => ({
    ats: 'greenhouse',
    token,
    name: token,
    host: null,
    marked: false,
  });

  it('marks boards that posted in Germany or remote EU and leaves a failing board alone', async () => {
    const marked: string[] = [];
    const directory = {
      listUnmarked: () => Promise.resolve([board('de'), board('us'), board('down')]),
      mark: (_ats: string, tokens: string[]) => {
        marked.push(...tokens);
        return Promise.resolve();
      },
    } as unknown as BoardDirectory;
    const result = await markBoards(directory, 'greenhouse', (b) => {
      if (b.token === 'down') return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve([b.token === 'de' ? 'Berlin' : 'Austin, TX']);
    });
    expect(marked).toEqual(['de']);
    expect(result).toEqual({ checked: 3, marked: 1, failed: ['greenhouse board down: HTTP 404'] });
  });
});

describe('bundled company lists', () => {
  it('loads every list with ats, token, name and the Lever host', () => {
    const boards = loadBundledBoards();
    const count = (ats: string): number => boards.filter((b) => b.ats === ats).length;
    expect(count('greenhouse')).toBeGreaterThan(1000);
    expect(count('lever')).toBeGreaterThan(500);
    expect(count('ashby')).toBeGreaterThan(500);
    expect(boards.some((b) => b.ats === 'lever' && b.host === 'eu')).toBe(true);
    expect(boards.every((b) => b.token !== '' && b.name !== '')).toBe(true);
  });
});
