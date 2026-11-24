import { describe, expect, it } from 'vitest';
import { buildPrompt, judgeLanguage, LANGUAGE_CAP, parseAssessment } from './scoring';
import type { MatchableJob } from './filters';
import { resolveCriteria, emptyCriteria } from './criteria';

const lang = (
  language: string,
  required: 'none' | 'optional' | 'required',
  level: string | null,
) => ({
  language,
  required,
  level: level as 'B2' | null,
  phrase: null,
});

describe('parseAssessment', () => {
  it('reads the JSON answer, also inside a code fence, and rounds the score', () => {
    const body = JSON.stringify({ score: 71.6, reasons: ['a'], redFlags: [], languages: [] });
    expect(parseAssessment(body).score).toBe(72);
    expect(parseAssessment('```json\n' + body + '\n```').score).toBe(72);
  });

  it.each([
    ['not json'],
    [JSON.stringify({ score: 101, reasons: [], redFlags: [], languages: [] })],
    [JSON.stringify({ score: -1, reasons: [], redFlags: [], languages: [] })],
    [JSON.stringify({ reasons: [], redFlags: [], languages: [] })],
    [
      JSON.stringify({
        score: 5,
        reasons: [],
        redFlags: [],
        languages: [{ language: 'de', required: 'maybe', level: null, phrase: null }],
      }),
    ],
  ])('rejects %s', (body) => {
    expect(() => parseAssessment(body)).toThrow();
  });
});

describe('judgeLanguage', () => {
  it('cannot judge when the Target has no language ability set', () => {
    expect(judgeLanguage(null, [lang('de', 'required', 'C1')])).toEqual({ met: null, unmet: [] });
  });

  it('a requirement above the ability is unmet, at or below it is met (0 jobs need not matter)', () => {
    expect(judgeLanguage(['de:A2'], [lang('de', 'required', 'B2')])).toEqual({
      met: false,
      unmet: ['de:B2'],
    });
    expect(
      judgeLanguage(
        ['de:B2', 'en:C1'],
        [lang('de', 'required', 'B2'), lang('en', 'required', 'B2')],
      ),
    ).toEqual({
      met: true,
      unmet: [],
    });
  });

  it('optional and none requirements never fail', () => {
    expect(
      judgeLanguage(['en:A1'], [lang('de', 'optional', 'C2'), lang('fr', 'none', null)]).met,
    ).toBe(true);
  });

  it('a language the Target does not list is unmet, and a required one without a level needs B2', () => {
    expect(judgeLanguage(['en:C1'], [lang('de', 'required', null)])).toEqual({
      met: false,
      unmet: ['de:B2'],
    });
    expect(judgeLanguage(['de:B1'], [lang('de', 'required', null)]).met).toBe(false);
    expect(judgeLanguage(['de:C1'], [lang('de', 'required', null)]).met).toBe(true);
  });

  it('ignores ability entries it cannot read and matches case-insensitively', () => {
    expect(judgeLanguage(['DE:b2', 'nonsense'], [lang('de', 'required', 'B2')]).met).toBe(true);
    expect(judgeLanguage(['nonsense'], [lang('de', 'required', 'A1')]).met).toBe(false);
  });

  it('the cap is a fixed number below any usual threshold', () => {
    expect(LANGUAGE_CAP).toBe(20);
  });
});

describe('buildPrompt', () => {
  const job: MatchableJob = {
    id: 'j',
    title: 'Beispiel Rolle',
    company: 'Beispiel GmbH',
    location: 'Köln',
    raw: { description: 'x'.repeat(20_000) },
    recency: new Date('2026-01-01'),
  };
  const resolved = resolveCriteria(emptyCriteria(), {
    ...emptyCriteria(),
    keywords: ['alpha'],
    languageAbility: ['de:A2'],
  });

  it('holds the posting, the Target keywords, no language ability, and a bounded amount of text', () => {
    const p = buildPrompt(resolved, job);
    expect(p).toContain('Beispiel Rolle');
    expect(p).toContain('alpha');
    expect(p).not.toContain('de:A2');
    expect(p.length).toBeLessThan(10_000);
  });
});
