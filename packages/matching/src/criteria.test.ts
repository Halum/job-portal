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
    const globals = base({ keywords: ['koch'], locations: ['Bamberg'], radiusKm: 25 });
    const target = base({ keywords: ['kellner'] });
    const r = resolveCriteria(globals, target);
    expect(r.keywords).toEqual(['kellner']);
    expect(r.locations).toEqual(['Bamberg']);
    expect(r.radiusKm).toBe(25);
  });

  it('treats 0, false and an empty list on a Target as set, not as unset', () => {
    const globals = base({
      radiusKm: 25,
      alertThreshold: 80,
      salaryFloor: 15000,
      remoteAllowed: true,
      keywords: ['koch'],
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
    const globals = base({ exclusionWords: ['Pflege', 'Kurier'], blockedCompanies: ['Acme'] });
    const target = base({ exclusionWords: ['pflege', 'Zeitarbeit'], blockedCompanies: null });
    const r = resolveCriteria(globals, target);
    expect(r.exclusionWords).toEqual(['Pflege', 'Kurier', 'Zeitarbeit']);
    expect(r.blockedCompanies).toEqual(['Acme']);
  });

  it('leaves everything unset when nothing is set anywhere', () => {
    expect(resolveCriteria(emptyCriteria(), emptyCriteria())).toEqual({
      ...emptyCriteria(),
      exclusionWords: [],
      blockedCompanies: [],
    });
  });
});

describe('applyPatch and the zod rules', () => {
  it('changes only the keys given and clears a key given as null', () => {
    const start = base({ keywords: ['koch'], radiusKm: 25 });
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
    ['radiusKm', -1],
    ['salaryFloor', -5],
    ['alertThreshold', 101],
    ['alertThreshold', -1],
  ])('rejects %s = %j', (key, value) => {
    expect(criteriaPatchSchema.safeParse({ [key]: value }).success).toBe(false);
    expect(() => applyPatch(emptyCriteria(), { [key]: value })).toThrow();
  });

  it('accepts prerankTopN of at least 1 and rejects blank words', () => {
    expect(criteriaPatchSchema.safeParse({ prerankTopN: 1 }).success).toBe(true);
    expect(criteriaPatchSchema.safeParse({ keywords: [' '] }).success).toBe(false);
  });
});
