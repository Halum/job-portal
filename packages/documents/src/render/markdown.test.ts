import { describe, expect, it } from 'vitest';
import { letterMarkdown, resumeMarkdown } from './markdown';
import { sampleLetter, sampleResume } from './fixtures';

describe('resumeMarkdown', () => {
  it('derives the CV from the structured content, newest role first', () => {
    const md = resumeMarkdown(sampleResume);
    expect(md.startsWith('# Mia Müller-Süß\n')).toBe(true);
    expect(md).toContain('## Berufserfahrung');
    expect(md).toContain('### Beiköchin, Café Größenwahn (Erlangen)\n01/2023 - heute');
    expect(md).toContain('- Frühstückskarte mit Öko-Zutaten entwickelt');
    expect(md.indexOf('Café Größenwahn')).toBeLessThan(md.indexOf('Gasthaus Zur Äpfelblüte'));
    expect(md).toContain('## Sprachen\n- Deutsch: C1');
    expect(md).toContain('## Zertifikate');
  });
});

describe('letterMarkdown', () => {
  it('derives the letter in reading order', () => {
    const md = letterMarkdown(sampleLetter);
    const parts = [
      'Brauerei Fröhlich GmbH',
      'Bamberg, 25.11.2026',
      '**Bewerbung als Küchenhilfe**',
      'Sehr geehrte Frau Schäfer,',
      'mit großer Freude',
      'Mit freundlichen Grüßen',
      'Mia Müller-Süß',
    ];
    const at = parts.map((p) => md.lastIndexOf(p));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});
