import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/template.js';

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(
      renderTemplate('Hello {{name}}, welcome to {{place}}', { name: 'Ana', place: 'Bamberg' }),
    ).toBe('Hello Ana, welcome to Bamberg');
  });

  it('resolves unknown placeholders to empty string, never leaves them literal', () => {
    expect(renderTemplate('{{title}} at {{unknown}}', { title: 'Dev' })).toBe('Dev at ');
  });

  it('handles no placeholders', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });
});
