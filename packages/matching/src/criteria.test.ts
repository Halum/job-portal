import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  criteriaPatchSchema,
  criteriaSchema,
  emptyCriteria,
  resolveCriteria,
  type Criteria,
} from './criteria';

const base = (over: Partial<Criteria>): Criteria => ({ ...emptyCriteria(), ...over });

describe('resolveCriteria', () => {
  it('lets a set Target field replace the Global default and an unset one fall back', () => {
    const globals = base({ keywords: ['alpha'], locations: ['Köln'], radiusKm: 7 });
    const target = base({ keywords: ['beta'] });
    const r = resolveCriteria(globals, target);
    expect(r.keywords).toEqual(['beta']);
    expect(r.locations).toEqual(['Köln']);
    expect(r.radiusKm).toBe(7);
  });

  it('treats 0, false and an empty list on a Target as set, not as unset', () => {
    const globals = base({
      radiusKm: 7,
      alertThreshold: 80,
      salaryFloor: 15000,
      remoteAllowed: true,
      keywords: ['alpha'],
    });
    const target = base({
      radiusKm: 0,
      alertThreshold: 0,
      salaryFloor: 0,
      remoteAllowed: false,
      keywords: [],
    });
    expect(resolveCriteria(globals, target)).toMatchObject({
      radiusKm: 0,
      alertThreshold: 0,
      salaryFloor: 0,
      remoteAllowed: false,
      keywords: [],
    });
  });

  it('falls back to a Global default of 0 or false when the Target leaves it unset', () => {
    const globals = base({ radiusKm: 0, alertThreshold: 0, remoteAllowed: false });
    expect(resolveCriteria(globals, emptyCriteria())).toMatchObject({
      radiusKm: 0,
      alertThreshold: 0,
      remoteAllowed: false,
    });
  });

  it('unions exclusion words and blocked companies, ignoring case and keeping the first spelling', () => {
    const globals = base({ exclusionWords: ['Spam', 'Kurier'], blockedCompanies: ['Acme'] });
    const target = base({ exclusionWords: ['spam', 'Zeitarbeit'], blockedCompanies: null });
    const r = resolveCriteria(globals, target);
    expect(r.exclusionWords).toEqual(['Spam', 'Kurier', 'Zeitarbeit']);
    expect(r.blockedCompanies).toEqual(['Acme']);
  });

  it('leaves everything unset when nothing is set anywhere', () => {
    // goneColdDays is a Global default only: it is not part of what a Target resolves to.
    const { goneColdDays: _unused, ...unset } = emptyCriteria();
    expect(resolveCriteria(emptyCriteria(), emptyCriteria())).toEqual({
      ...unset,
      exclusionWords: [],
      blockedCompanies: [],
    });
  });
});

describe('applyPatch and the zod rules', () => {
  it('changes only the keys given and clears a key given as null', () => {
    const start = base({ keywords: ['alpha'], radiusKm: 7 });
    const next = applyPatch(start, { radiusKm: null, salaryFloor: 0 });
    expect(next).toEqual({ ...start, radiusKm: null, salaryFloor: 0 });
  });

  it('accepts the zero rules: threshold 0, radius 0, salary floor 0', () => {
    expect(() =>
      criteriaSchema.parse({ ...emptyCriteria(), alertThreshold: 0, radiusKm: 0, salaryFloor: 0 }),
    ).not.toThrow();
  });

  it.each([
    ['prerankTopN', 0],
    ['prerankTopN', 1.5],
    ['goneColdDays', 0],
    ['goneColdDays', -1],
    ['goneColdDays', 1.5],
    ['radiusKm', -1],
    ['salaryFloor', -5],
    ['alertThreshold', 101],
    ['alertThreshold', -1],
  ])('rejects %s = %j', (key, value) => {
    expect(criteriaPatchSchema.safeParse({ [key]: value }).success).toBe(false);
    expect(() => applyPatch(emptyCriteria(), { [key]: value })).toThrow();
  });

  it('accepts goneColdDays of 1 or more and null, which disables the Gone cold check', () => {
    expect(criteriaPatchSchema.safeParse({ goneColdDays: 1 }).success).toBe(true);
    expect(criteriaPatchSchema.safeParse({ goneColdDays: 14 }).success).toBe(true);
    expect(criteriaPatchSchema.safeParse({ goneColdDays: null }).success).toBe(true);
    expect(emptyCriteria().goneColdDays).toBeNull();
  });

  it('accepts prerankTopN of at least 1 and rejects blank words', () => {
    expect(criteriaPatchSchema.safeParse({ prerankTopN: 1 }).success).toBe(true);
    expect(criteriaPatchSchema.safeParse({ keywords: [' '] }).success).toBe(false);
  });

  it('caps the number and the length of words', () => {
    const many = Array.from({ length: 51 }, (_, i) => `w${String(i)}`);
    expect(criteriaPatchSchema.safeParse({ keywords: many.slice(0, 50) }).success).toBe(true);
    expect(criteriaPatchSchema.safeParse({ keywords: many }).success).toBe(false);
    expect(criteriaPatchSchema.safeParse({ blockedCompanies: ['a'.repeat(100)] }).success).toBe(
      true,
    );
    expect(criteriaPatchSchema.safeParse({ locations: ['a'.repeat(101)] }).success).toBe(false);
  });
});
