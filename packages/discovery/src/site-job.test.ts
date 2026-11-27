import { describe, expect, it } from 'vitest';
import { siteJobId } from './site-job';

describe('siteJobId, LinkedIn', () => {
  it.each([
    ['https://www.linkedin.com/jobs/view/alpha-developer-at-beispiel-1234567890', '1234567890'],
    [
      'https://de.linkedin.com/jobs/view/alpha-developer-at-beispiel-1234567890?trk=public_jobs',
      '1234567890',
    ],
    ['https://www.linkedin.com/jobs/view/1234567890/', '1234567890'],
    ['https://www.linkedin.com/jobs/view/1234567890', '1234567890'],
    ['https://www.linkedin.com/comm/jobs/view/1234567890?refId=abc&trackingId=def', '1234567890'],
    ['https://linkedin.com/jobs/view/alpha-1234567890/?utm_source=x#frag', '1234567890'],
    ['https://www.linkedin.com/jobs/search/?keywords=alpha&currentJobId=1234567890', '1234567890'],
    ['https://uk.linkedin.com/jobs/collections/recommended/?currentJobId=1234567890', '1234567890'],
  ])('reads %s', (url, id) => {
    expect(siteJobId(url)).toEqual({ site: 'linkedin', id });
  });

  it.each([
    'https://www.linkedin.com/jobs/search/?keywords=alpha',
    'https://www.linkedin.com/jobs/view/alpha-developer',
    'https://www.linkedin.com/company/beispiel-1234567890',
    'https://www.linkedin.com/in/someone-1234567890',
    'https://www.linkedin.com/jobs/search/?currentJobId=abc',
    'https://notlinkedin.com/jobs/view/1234567890',
    'https://linkedin.com.example.org/jobs/view/1234567890',
  ])('is null for %s', (url) => {
    expect(siteJobId(url)).toBeNull();
  });
});

describe('siteJobId, LinkedIn edge cases', () => {
  it('reads a long run of digits followed by a letter in linear time', () => {
    const url = `https://www.linkedin.com/jobs/view/${'1'.repeat(50000)}x`;
    const start = performance.now();
    expect(siteJobId(url)).toBeNull();
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('does not read currentJobId from a path that only starts with /jobs', () => {
    expect(siteJobId('https://www.linkedin.com/jobsearch?currentJobId=1234567890')).toBeNull();
  });

  it('reads currentJobId when a /jobs/view/ path carries no id', () => {
    expect(siteJobId('https://www.linkedin.com/jobs/view/?currentJobId=1234567890')).toEqual({
      site: 'linkedin',
      id: '1234567890',
    });
  });
});

describe('siteJobId, Indeed', () => {
  it.each([
    ['https://www.indeed.com/viewjob?jk=0123456789abcdef', '0123456789abcdef'],
    ['https://de.indeed.com/viewjob?jk=0123456789abcdef&from=serp&vjs=3', '0123456789abcdef'],
    ['https://de.indeed.com/jobs?q=alpha&l=Musterstadt&vjk=0123456789abcdef', '0123456789abcdef'],
    ['https://uk.indeed.com/m/viewjob?jk=0123456789abcdef', '0123456789abcdef'],
    ['https://www.indeed.co.uk/viewjob?jk=0123456789abcdef', '0123456789abcdef'],
    ['https://indeed.fr/viewjob?jk=0123456789abcdef', '0123456789abcdef'],
    ['https://www.indeed.com.au/viewjob?vjk=0123456789abcdef', '0123456789abcdef'],
  ])('reads %s', (url, id) => {
    expect(siteJobId(url)).toEqual({ site: 'indeed', id });
  });

  it('lowercases the job key so its case never makes a second key', () => {
    expect(siteJobId('https://de.indeed.com/viewjob?jk=ABCDEF0123456789')).toEqual({
      site: 'indeed',
      id: 'abcdef0123456789',
    });
  });

  it('prefers jk over vjk', () => {
    expect(
      siteJobId('https://de.indeed.com/jobs?vjk=bbbbbbbbbbbbbbbb&jk=aaaaaaaaaaaaaaaa'),
    ).toEqual({
      site: 'indeed',
      id: 'aaaaaaaaaaaaaaaa',
    });
  });

  it.each([
    'https://de.indeed.com/jobs?q=alpha&l=Musterstadt',
    'https://de.indeed.com/viewjob',
    'https://de.indeed.com/viewjob?jk=',
    'https://notindeed.com/viewjob?jk=0123456789abcdef',
    'https://indeed.com.example.org/viewjob?jk=0123456789abcdef',
  ])('is null for %s', (url) => {
    expect(siteJobId(url)).toBeNull();
  });
});

describe('siteJobId, anything else', () => {
  it.each([
    'https://example.org/jobs/view/1234567890',
    'not a url',
    'ftp://www.linkedin.com/jobs/view/123',
    '',
  ])('is null for %s', (url) => {
    expect(siteJobId(url)).toBeNull();
  });
});
