import { describe, expect, it } from 'vitest';
import { isValidBoardToken, resolveBoardUrl } from './board-url';
import { fetchBoardPostings } from './ats';

describe('resolveBoardUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme', { ats: 'greenhouse', token: 'acme' }],
    ['https://boards.greenhouse.io/acme/jobs/123?gh_src=x', { ats: 'greenhouse', token: 'acme' }],
    ['https://job-boards.greenhouse.io/acme', { ats: 'greenhouse', token: 'acme' }],
    ['https://job-boards.eu.greenhouse.io/acme', { ats: 'greenhouse', token: 'acme' }],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', { ats: 'greenhouse', token: 'acme' }],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', { ats: 'greenhouse', token: 'acme' }],
    ['https://jobs.lever.co/acme', { ats: 'lever', token: 'acme' }],
    ['https://jobs.lever.co/acme/0000-1111?lever-source=x', { ats: 'lever', token: 'acme' }],
    ['https://jobs.eu.lever.co/acme', { ats: 'lever', token: 'acme', host: 'eu' }],
    ['https://jobs.ashbyhq.com/acme', { ats: 'ashby', token: 'acme' }],
    ['https://jobs.ashbyhq.com/acme/0000-1111/application', { ats: 'ashby', token: 'acme' }],
    ['https://jobs.ashbyhq.com/Acme.Co_1-x', { ats: 'ashby', token: 'Acme.Co_1-x' }],
  ])('recognises %s', (url, board) => {
    expect(resolveBoardUrl(url)).toEqual(board);
  });

  it.each([
    'https://example.com/acme',
    'https://evil.example/jobs.lever.co/acme',
    'https://jobs.lever.co.evil.example/acme',
    'http://jobs.lever.co/acme',
    'https://jobs.lever.co/',
    'https://jobs.lever.co/..',
    'https://jobs.lever.co/.',
    'https://jobs.lever.co/a%2Fb',
    'https://boards.greenhouse.io/embed/job_board',
    'https://boards.greenhouse.io/embed/job_board?for=..',
    'https://user:pw@jobs.lever.co/acme',
    'not a url',
    '',
  ])('rejects %j', (url) => {
    expect(resolveBoardUrl(url)).toBeNull();
  });
});

describe('isValidBoardToken', () => {
  it.each(['acme', 'a.b', 'a_b-c', 'A1'])('accepts %s', (t) => {
    expect(isValidBoardToken(t)).toBe(true);
  });
  it.each(['', '.', '..', 'a/b', 'a b', 'a?b', 'a#b', 'a%2e', '../x', 'ä'])('rejects %j', (t) => {
    expect(isValidBoardToken(t)).toBe(false);
  });
});

describe('fetchBoardPostings refuses a bad token before any request', () => {
  it.each(['..', '.', 'a/b', ''])('token %j', async (token) => {
    let called = false;
    const spy: typeof fetch = () => {
      called = true;
      return Promise.resolve(new Response('{}'));
    };
    await expect(fetchBoardPostings('greenhouse', { token, name: 'x' }, spy)).rejects.toThrow(
      /invalid board token/,
    );
    expect(called).toBe(false);
  });
});
