import { describe, expect, it } from 'vitest';
import { emptyCriteria, resolveCriteria, type Criteria } from './criteria';
import { hardFilter, prerank, prerankScore, type MatchableJob } from './filters';
import { createPlaceTable } from './places';

const places = createPlaceTable(
  [
    '96047\tBamberg\t49.8917\t10.8864',
    '90402\tNürnberg\t49.4539\t11.0775',
    '10115\tBerlin\t52.5323\t13.3846',
  ].join('\n'),
);

const job = (over: Partial<MatchableJob> = {}): MatchableJob => ({
  id: 'j1',
  title: 'Koch (m/w/d)',
  company: 'Beispiel Firma',
  location: 'Bamberg',
  raw: {},
  recency: new Date('2026-01-01'),
  ...over,
});
const crit = (over: Partial<Criteria>) =>
  resolveCriteria(emptyCriteria(), { ...emptyCriteria(), ...over });

describe('hardFilter', () => {
  it('passes everything when no criteria are set', () => {
    expect(hardFilter(job(), crit({}), places)).toEqual({ pass: true, unknownLocation: false });
  });

  it('drops a job with an exclusion word in title, company or location, ignoring case', () => {
    expect(
      hardFilter(job({ title: 'Pflege Helfer' }), crit({ exclusionWords: ['pflege'] }), places)
        .pass,
    ).toBe(false);
    expect(
      hardFilter(
        job({ company: 'Zeitarbeit AG' }),
        crit({ exclusionWords: ['ZEITARBEIT'] }),
        places,
      ).pass,
    ).toBe(false);
    expect(hardFilter(job(), crit({ exclusionWords: ['pflege'] }), places).pass).toBe(true);
  });

  it('drops a blocked company', () => {
    expect(
      hardFilter(job({ company: 'Acme GmbH' }), crit({ blockedCompanies: ['acme'] }), places).pass,
    ).toBe(false);
    expect(
      hardFilter(job({ company: null }), crit({ blockedCompanies: ['acme'] }), places).pass,
    ).toBe(true);
  });

  it('radius 0 means the same city only', () => {
    const c = crit({ locations: ['Bamberg'], radiusKm: 0 });
    expect(hardFilter(job({ location: 'Bamberg' }), c, places).pass).toBe(true);
    expect(hardFilter(job({ location: '96047 Bamberg' }), c, places).pass).toBe(true);
    expect(hardFilter(job({ location: 'Nürnberg' }), c, places).pass).toBe(false);
  });

  it('keeps jobs inside the radius and drops those outside', () => {
    const near = crit({ locations: ['Bamberg'], radiusKm: 60 });
    const far = crit({ locations: ['Bamberg'], radiusKm: 30 });
    expect(hardFilter(job({ location: 'Nürnberg' }), near, places).pass).toBe(true);
    expect(hardFilter(job({ location: 'Nürnberg' }), far, places).pass).toBe(false);
    expect(hardFilter(job({ location: 'Berlin' }), near, places).pass).toBe(false);
  });

  it('passes an unknown place with the unknown-location flag instead of dropping it', () => {
    const c = crit({ locations: ['Bamberg'], radiusKm: 10 });
    expect(hardFilter(job({ location: 'Musterstadt' }), c, places)).toEqual({
      pass: true,
      unknownLocation: true,
    });
    expect(hardFilter(job({ location: null }), c, places)).toEqual({
      pass: true,
      unknownLocation: true,
    });
  });

  it('passes with the flag when the Target place itself is unknown', () => {
    const c = crit({ locations: ['Musterstadt'], radiusKm: 10 });
    expect(hardFilter(job(), c, places)).toEqual({ pass: true, unknownLocation: true });
  });

  it('does not check places when locations or radius are unset', () => {
    expect(
      hardFilter(job({ location: 'Berlin' }), crit({ locations: ['Bamberg'] }), places).pass,
    ).toBe(true);
    expect(hardFilter(job({ location: 'Berlin' }), crit({ radiusKm: 5 }), places).pass).toBe(true);
  });

  it('lets remote postings past the radius unless the Target refuses remote', () => {
    const remote = job({ title: 'Webentwickler (Remote)', location: 'Berlin' });
    const base = { locations: ['Bamberg'], radiusKm: 10 };
    expect(hardFilter(remote, crit({ ...base, remoteAllowed: true }), places)).toEqual({
      pass: true,
      unknownLocation: false,
    });
    expect(hardFilter(remote, crit({ ...base, remoteAllowed: null }), places).pass).toBe(true);
    expect(hardFilter(remote, crit({ ...base, remoteAllowed: false }), places).pass).toBe(false);
    expect(
      hardFilter(job({ title: 'Büro im Homeoffice' }), crit({ remoteAllowed: false }), places).pass,
    ).toBe(false);
  });
});

describe('prerankScore and prerank', () => {
  it('counts a title hit 3, a hit elsewhere in the payload 1, each keyword once', () => {
    const j = job({
      title: 'Koch in Vollzeit',
      raw: { beruf: { name: 'Küchenhilfe' }, tags: ['Gastro'] },
    });
    expect(prerankScore(j, ['koch'])).toBe(3);
    expect(prerankScore(j, ['gastro'])).toBe(1);
    expect(prerankScore(j, ['koch', 'gastro', 'KOCH', 'nichts'])).toBe(4);
    expect(prerankScore(j, [])).toBe(0);
    expect(prerankScore(j, ['  '])).toBe(0);
  });

  const scored = (id: string, score: number, day: number) => ({
    job: job({ id, recency: new Date(2026, 0, day) }),
    score,
  });

  it('keeps the top N by score, newest first on a tie, and drops zero scores when keywords exist', () => {
    const items = [scored('a', 3, 1), scored('b', 3, 5), scored('c', 1, 9), scored('d', 0, 9)];
    expect(prerank(items, 2, true).map((s) => s.job.id)).toEqual(['b', 'a']);
    expect(prerank(items, 10, true).map((s) => s.job.id)).toEqual(['b', 'a', 'c']);
  });

  it('without keywords everything ties and the newest N pass', () => {
    const items = [scored('a', 0, 1), scored('b', 0, 5), scored('c', 0, 9)];
    expect(prerank(items, 2, false).map((s) => s.job.id)).toEqual(['c', 'b']);
  });

  it('breaks a full tie by id so the result is stable', () => {
    const items = [scored('b', 1, 1), scored('a', 1, 1)];
    expect(prerank(items, 5, true).map((s) => s.job.id)).toEqual(['a', 'b']);
  });
});

describe('hardFilter word matching', () => {
  it('matches exclusion words and blocked companies as whole words, not substrings', () => {
    const kitchen = job({ title: 'Kitchen Assistant', company: 'Sapphire Foods' });
    expect(hardFilter(kitchen, crit({ exclusionWords: ['IT'] }), places).pass).toBe(true);
    expect(hardFilter(kitchen, crit({ blockedCompanies: ['SAP'] }), places).pass).toBe(true);
    const it = job({ title: 'IT Support (m/w/d)', company: 'SAP SE' });
    expect(hardFilter(it, crit({ exclusionWords: ['it'] }), places).pass).toBe(false);
    expect(hardFilter(it, crit({ blockedCompanies: ['sap'] }), places).pass).toBe(false);
  });

  it('treats umlauts as letters and words with symbols as whole words', () => {
    expect(
      hardFilter(job({ title: 'Büroleiter' }), crit({ exclusionWords: ['Büro'] }), places).pass,
    ).toBe(true);
    expect(
      hardFilter(job({ title: 'Büro Assistent' }), crit({ exclusionWords: ['büro'] }), places).pass,
    ).toBe(false);
    expect(
      hardFilter(job({ title: 'C++ Entwickler' }), crit({ exclusionWords: ['C++'] }), places).pass,
    ).toBe(false);
  });
});

describe('hardFilter remote detection', () => {
  const refuse = crit({ remoteAllowed: false });
  const isRemote = (j: MatchableJob): boolean => !hardFilter(j, refuse, places).pass;

  it('does not read remote into other phrases', () => {
    expect(isRemote(job({ title: 'Remote Sensing Engineer', location: 'Bamberg' }))).toBe(false);
    expect(isRemote(job({ title: 'Engineer, not remote', location: 'Bamberg' }))).toBe(false);
    expect(isRemote(job({ title: 'Engineer', location: 'Bamberg (kein Homeoffice)' }))).toBe(false);
  });

  it('reads remote from the place, the work type fields and the title phrases sources use', () => {
    expect(isRemote(job({ title: 'Engineer', location: 'Remote' }))).toBe(true);
    expect(isRemote(job({ title: 'Engineer', location: 'Remote, Germany' }))).toBe(true);
    expect(isRemote(job({ title: 'Engineer - Remote', location: 'Berlin' }))).toBe(true);
    expect(isRemote(job({ title: 'Engineer (Remote)', location: 'Berlin' }))).toBe(true);
    expect(isRemote(job({ title: 'Engineer', location: 'Berlin', raw: { isRemote: true } }))).toBe(
      true,
    );
    expect(
      isRemote(job({ title: 'Engineer', location: 'Berlin', raw: { workplaceType: 'Remote' } })),
    ).toBe(true);
    expect(
      isRemote(job({ title: 'Engineer', location: 'Berlin', raw: { workplaceType: 'hybrid' } })),
    ).toBe(false);
    expect(isRemote(job({ title: 'Büro im Homeoffice', location: 'Berlin' }))).toBe(true);
  });
});
