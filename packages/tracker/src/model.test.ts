import { describe, expect, it } from 'vitest';
import { checkApplicationChange, checkDiscoveryChange, nextFurthest } from './model';

const change = (
  current: Parameters<typeof checkApplicationChange>[0]['status'],
  to: Parameters<typeof checkApplicationChange>[1],
  actor: Parameters<typeof checkApplicationChange>[2] = 'user',
) => checkApplicationChange({ status: current, appliedOn: '2026-11-20' }, to, actor);

describe('application status transitions', () => {
  it('starts only with Applied, set by the user or the skill', () => {
    expect(change(null, 'applied')).toBeNull();
    expect(change(null, 'applied', 'skill')).toBeNull();
    expect(change(null, 'applied', 'gmail')).toMatch(/user or the skill/);
    expect(change(null, 'screening')).toMatch(/not applied/);
  });

  it('refuses a second Applied with the existing application date', () => {
    expect(change('screening', 'applied')).toMatch(/already applied on 2026-11-20/);
  });

  it('moves forward, and Rejected or Withdrawn from any non-final status', () => {
    expect(change('applied', 'interview', 'gmail')).toBeNull();
    expect(change('interview', 'offer')).toBeNull();
    expect(change('offer', 'declined')).toBeNull();
    expect(change('applied', 'rejected', 'gmail')).toBeNull();
    expect(change('gone_cold', 'withdrawn')).toBeNull();
  });

  it('refuses a move backwards or to the same status', () => {
    expect(change('interview', 'screening')).toMatch(/cannot go from interview to screening/);
    expect(change('interview', 'interview')).toMatch(/cannot go from interview to interview/);
  });

  it('changes a final status only by undo', () => {
    for (const final of ['accepted', 'declined', 'rejected', 'withdrawn'] as const) {
      expect(change(final, 'screening')).toMatch(/final/);
    }
  });

  it('lets only the system set Gone cold, and a late reply moves a Gone cold Job on', () => {
    expect(change('applied', 'gone_cold', 'system')).toBeNull();
    expect(change('applied', 'gone_cold', 'user')).toMatch(/system/);
    expect(change('gone_cold', 'screening', 'gmail')).toBeNull();
  });
});

describe('discovery state changes', () => {
  it('moves freely among the four states while there is no application status', () => {
    expect(checkDiscoveryChange('new', 'shortlisted', null, 'user')).toBeNull();
    expect(checkDiscoveryChange('dismissed', 'new', null, 'skill')).toBeNull();
  });
  it('refuses once the Job has an application status, a same-state change, or Expired by anyone else', () => {
    expect(checkDiscoveryChange('new', 'dismissed', 'applied', 'user')).toMatch(
      /application status/,
    );
    expect(checkDiscoveryChange('new', 'new', null, 'user')).toMatch(/already/);
    expect(checkDiscoveryChange('new', 'expired', null, 'system')).toMatch(/user or the skill/);
  });
});

describe('furthest stage', () => {
  it('only moves forward over Applied to Accepted', () => {
    expect(nextFurthest(null, 'applied')).toBe('applied');
    expect(nextFurthest('interview', 'screening')).toBe('interview');
    expect(nextFurthest('interview', 'offer')).toBe('offer');
    expect(nextFurthest('interview', 'rejected')).toBe('interview');
    expect(nextFurthest('applied', 'gone_cold')).toBe('applied');
  });
});
