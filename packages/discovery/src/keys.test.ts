import { describe, expect, it } from 'vitest';
import { companyKey, urlKey } from './keys';

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
