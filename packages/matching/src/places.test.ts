import { describe, expect, it } from 'vitest';
import { createPlaceTable, distanceKm, germanPlaces, normalizeName } from './places';

const tiny = createPlaceTable(
  [
    '96047\tBamberg\t49.8917\t10.8864',
    '96049\tBamberg\t49.9000\t10.9000',
    '90402\tNürnberg\t49.4539\t11.0775',
  ].join('\n'),
);

describe('place table', () => {
  it('resolves a name, a postcode and a name inside free text', () => {
    expect(tiny.resolve('Bamberg')?.name).toBe('Bamberg');
    expect(tiny.resolve('96047')?.name).toBe('Bamberg');
    expect(tiny.resolve('96047 Irgendwo')?.name).toBe('Bamberg');
    expect(tiny.resolve('Nürnberg, Mittelfranken')?.name).toBe('Nürnberg');
    expect(tiny.resolve('Nuernberg')?.key).toBe(tiny.resolve('Nürnberg')?.key);
  });

  it('returns null for an unknown place and for blank text', () => {
    expect(tiny.resolve('Musterstadt')).toBeNull();
    expect(tiny.resolve('')).toBeNull();
    expect(tiny.resolve('99999')).toBeNull();
  });

  it('averages the coordinates of a name listed under several postcodes', () => {
    const p = tiny.resolve('Bamberg');
    expect(p?.lat).toBeCloseTo((49.8917 + 49.9) / 2, 4);
  });

  it('ignores malformed lines', () => {
    expect(createPlaceTable('garbage\n\n').resolve('x')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('folds case, umlauts, sharp s and punctuation', () => {
    expect(normalizeName('Düsseldorf')).toBe('duesseldorf');
    expect(normalizeName('Frankfurt (Oder)')).toBe('frankfurtoder');
    expect(normalizeName('Straße')).toBe('strasse');
  });
});

describe('distanceKm', () => {
  it('is zero for the same point and about 6 km for 0.054 degrees of latitude', () => {
    const a = { lat: 50, lon: 10 };
    expect(distanceKm(a, a)).toBe(0);
    expect(distanceKm(a, { lat: 50.054, lon: 10 })).toBeCloseTo(6.0, 1);
  });
});

describe('bundled GeoNames table', () => {
  it('knows big German cities and their distances', () => {
    const t = germanPlaces();
    const bamberg = t.resolve('Bamberg');
    const nuernberg = t.resolve('Nürnberg');
    const berlin = t.resolve('Berlin');
    expect(bamberg && nuernberg && berlin).toBeTruthy();
    if (!bamberg || !nuernberg || !berlin) return;
    expect(distanceKm(bamberg, nuernberg)).toBeGreaterThan(40);
    expect(distanceKm(bamberg, nuernberg)).toBeLessThan(60);
    expect(distanceKm(bamberg, berlin)).toBeGreaterThan(300);
    expect(distanceKm(bamberg, berlin)).toBeLessThan(380);
    expect(t.resolve('96047')?.name).toBe('Bamberg');
  });
});
