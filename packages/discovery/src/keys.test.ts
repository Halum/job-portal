import { describe, expect, it } from 'vitest';
import { companyKey, nearBucket, titleOverlap, urlKey } from './keys';

describe('nearBucket and titleOverlap', () => {
  it('buckets by normalized company and city, null when either is missing', () => {
    expect(nearBucket({ company: 'Beispiel GmbH', location: '96047 Bamberg' })).toBe(
      nearBucket({ company: 'beispiel', location: 'Bamberg' }),
    );
    expect(nearBucket({ company: 'Beispiel GmbH', location: null })).toBeNull();
    expect(nearBucket({ company: ' ', location: 'Bamberg' })).toBeNull();
  });

  it('is the share of title words in common, ignoring case, gender tags and punctuation', () => {
    expect(titleOverlap('Koch (m/w/d)', 'koch')).toBe(1);
    expect(titleOverlap('Alpha Developer Backend', 'Alpha Developer Backend Senior')).toBe(0.75);
    expect(titleOverlap('Gardener', 'Alpha Developer')).toBe(0);
    expect(titleOverlap('', 'Alpha')).toBe(0);
  });
});

describe('companyKey', () => {
  it('is null unless company, title and city are all present', () => {
    expect(companyKey({ company: 'Beispiel GmbH', title: 'Koch', location: undefined })).toBeNull();
    expect(companyKey({ company: null, title: 'Koch', location: 'Musterstadt' })).toBeNull();
    expect(
      companyKey({ company: 'Beispiel GmbH', title: ' ', location: 'Musterstadt' }),
    ).toBeNull();
  });

  it('ignores case, accents, punctuation and the legal suffix', () => {
    const a = companyKey({
      company: 'Müller & Söhne GmbH & Co. KG',
      title: 'Koch (m/w/d)',
      location: 'Bamberg',
    });
    const b = companyKey({ company: 'MULLER und SOHNE', title: 'koch', location: 'bamberg' });
    expect(a).toBe('muller und sohne|koch|bamberg');
    expect(b).toBe(a);
  });

  it('keeps different titles or cities apart', () => {
    const base = { company: 'Beispiel AG', title: 'Koch', location: 'Musterstadt' };
    expect(companyKey({ ...base, title: 'Küchenhilfe' })).not.toBe(companyKey(base));
    expect(companyKey({ ...base, location: 'Andernorts' })).not.toBe(companyKey(base));
  });
});

describe('companyKey normalization', () => {
  const key = (over: { company?: string; title?: string; location?: string }): string | null =>
    companyKey({ company: 'Beispiel AG', title: 'Koch', location: 'Bamberg', ...over });

  it('keeps C++ and C# apart, and from plain C', () => {
    const keys = new Set([
      key({ title: 'C++ Developer' }),
      key({ title: 'C# Developer' }),
      key({ title: 'C Developer' }),
    ]);
    expect(keys.size).toBe(3);
  });

  it('folds the sharp s to ss', () => {
    expect(key({ location: 'Straßburg' })).toBe(key({ location: 'Strassburg' }));
    expect(key({ company: 'Weiß AG' })).toBe(key({ company: 'Weiss AG' }));
  });

  it('strips e.V. as a legal suffix in its spellings', () => {
    const plain = key({ company: 'Sportverein Beispiel' });
    expect(key({ company: 'Sportverein Beispiel e.V.' })).toBe(plain);
    expect(key({ company: 'Sportverein Beispiel e. V.' })).toBe(plain);
    expect(key({ company: 'Sportverein Beispiel EV' })).toBe(plain);
  });

  it.each([
    'Koch m/w/d',
    'Koch w/m/d',
    'Koch d/m/w',
    'Koch (m/w/d)',
    'Koch M/W/D',
    'Koch m / w / d',
  ])('removes the gender marker from %j', (title) => {
    expect(key({ title })).toBe(key({ title: 'Koch' }));
  });

  it('strips a leading German postcode from the city, but not a trailing one', () => {
    expect(key({ location: '96047 Bamberg' })).toBe(key({ location: 'Bamberg' }));
    expect(key({ location: 'Bamberg 96047' })).not.toBe(key({ location: 'Bamberg' }));
  });
});

describe('urlKey', () => {
  it('drops scheme, www, fragment, tracking parameters and trailing slash', () => {
    const a = urlKey('https://www.Example.invalid/jobs/42/?utm_source=x&gclid=1&id=7#apply');
    expect(a).toBe('example.invalid/jobs/42?id=7');
    expect(urlKey('http://example.invalid/jobs/42?id=7')).toBe(a);
  });

  it('sorts the remaining parameters', () => {
    expect(urlKey('https://example.invalid/j?b=2&a=1')).toBe(
      urlKey('https://example.invalid/j?a=1&b=2'),
    );
  });

  it('is null for something that is not an absolute URL', () => {
    expect(urlKey('not a url')).toBeNull();
    expect(urlKey('')).toBeNull();
  });
});
