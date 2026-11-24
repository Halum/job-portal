import { describe, expect, it } from 'vitest';
import { createPlaceTable, distanceKm, germanPlaces, normalizeName } from './places';

const tiny = createPlaceTable(
  [
    '50667\tKöln\t49.8917\t10.8864',
    '50668\tKöln\t49.9000\t10.9000',
    '40213\tDüsseldorf\t49.4539\t11.0775',
  ].join('\n'),
);

describe('place table', () => {
  it('resolves a name, a postcode and a name inside free text', () => {
    expect(tiny.resolve('Köln')?.name).toBe('Köln');
    expect(tiny.resolve('50667')?.name).toBe('Köln');
    expect(tiny.resolve('50667 Irgendwo')?.name).toBe('Köln');
    expect(tiny.resolve('Düsseldorf, Rheinland')?.name).toBe('Düsseldorf');
    expect(tiny.resolve('Duesseldorf')?.key).toBe(tiny.resolve('Düsseldorf')?.key);
  });

  it('returns null for an unknown place and for blank text', () => {
    expect(tiny.resolve('Musterstadt')).toBeNull();
    expect(tiny.resolve('')).toBeNull();
    expect(tiny.resolve('99999')).toBeNull();
  });

  it('averages the coordinates of a name listed under several postcodes', () => {
    const p = tiny.resolve('Köln');
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
    const koeln = t.resolve('Köln');
    const duesseldorf = t.resolve('Düsseldorf');
    const berlin = t.resolve('Berlin');
    expect(koeln && duesseldorf && berlin).toBeTruthy();
    if (!koeln || !duesseldorf || !berlin) return;
    expect(distanceKm(koeln, duesseldorf)).toBeGreaterThan(25);
    expect(distanceKm(koeln, duesseldorf)).toBeLessThan(45);
    expect(distanceKm(koeln, berlin)).toBeGreaterThan(450);
    expect(distanceKm(koeln, berlin)).toBeLessThan(500);
    expect(t.resolve('50667')?.name).toBe('Köln');
  });
});
