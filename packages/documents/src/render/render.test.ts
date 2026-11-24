import { describe, expect, it } from 'vitest';
import { renderLetterPdf, renderResumePdf } from './pdf';
import { sampleLetter, sampleResume } from './fixtures';
import { extractPages } from './pdf-text';
import type { LetterContent, ResumeContent } from './content';

// A PNG header that declares a huge picture in a few bytes: the signature and an IHDR chunk, no pixel data.
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
  ]);
}

// A JPEG header with a baseline start-of-frame segment that declares the size.
function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.alloc(15);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof]);
}

const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('renderResumePdf', () => {
  it('writes a text-based one page PDF with the header and German umlauts', async () => {
    const out = await renderResumePdf(sampleResume);
    const text = (await extractPages(out.pdf)).join('\n');
    expect(out.pages).toBe(1);
    expect((await extractPages(out.pdf)).length).toBe(out.pages);
    expect(out.overCap).toBe(false);
    expect(text).toContain('Mia Müller-Süß');
    expect(text).toContain('mia.mueller@example.test');
    expect(text).toContain('Gasthaus Zur Äpfelblüte');
    expect(text).toContain('Großküche');
    expect(text).toContain('Öko-Zutaten');
  });

  it('orders sections as a German CV and work experiences newest first', async () => {
    const text = (await extractPages((await renderResumePdf(sampleResume)).pdf)).join(' ');
    const at = (s: string) => text.indexOf(s);
    const order = ['BERUFSERFAHRUNG', 'AUSBILDUNG', 'KENNTNISSE', 'SPRACHEN', 'ZERTIFIKATE'].map(
      at,
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The current role (Café Größenwahn) was listed second in the input but leads the section.
    expect(at('Café Größenwahn')).toBeLessThan(at('Gasthaus Zur Äpfelblüte'));
    expect(text).toContain('01/2023 - heute');
  });

  it('uses English headings for an English resume', async () => {
    const text = (
      await extractPages((await renderResumePdf({ ...sampleResume, locale: 'en' })).pdf)
    ).join(' ');
    expect(text).toContain('WORK EXPERIENCE');
    expect(text).toContain('present');
  });

  it('draws the photo only when one is given', async () => {
    const without = await renderResumePdf(sampleResume);
    const withPhoto = await renderResumePdf(sampleResume, { photo: PHOTO });
    expect(without.pdf.includes('/Subtype /Image')).toBe(false);
    expect(withPhoto.pdf.includes('/Subtype /Image')).toBe(true);
  });

  it('refuses a photo that declares huge dimensions before decoding it', async () => {
    await expect(renderResumePdf(sampleResume, { photo: pngHeader(12000, 12000) })).rejects.toThrow(
      /too large/,
    );
    await expect(
      renderResumePdf(sampleResume, { photo: jpegHeader(12000, 12000) }),
    ).rejects.toThrow(/too large/);
  });

  it('refuses photo bytes that are neither PNG nor JPEG', async () => {
    await expect(
      renderResumePdf(sampleResume, { photo: Buffer.from('<svg></svg>') }),
    ).rejects.toThrow(/PNG or JPEG/);
  });

  it('reports a long resume over the 2 page cap and never cuts content', async () => {
    const long: ResumeContent = {
      ...sampleResume,
      experiences: Array.from({ length: 12 }, (_, i) => ({
        role: `Stelle ${String(i + 1)}`,
        organisation: `Betrieb ${String(i + 1)}`,
        start: `20${String(10 + i).padStart(2, '0')}-01`,
        end: `20${String(10 + i).padStart(2, '0')}-12`,
        points: Array.from(
          { length: 6 },
          (_, j) =>
            `Aufgabe ${String(j + 1)} von Stelle ${String(i + 1)} mit etwas längerem Text, damit die Zeile umbricht und Platz braucht`,
        ),
      })),
    };
    const out = await renderResumePdf(long);
    const text = (await extractPages(out.pdf)).join(' ');
    expect((await extractPages(out.pdf)).length).toBe(out.pages);
    expect(out.pages).toBeGreaterThan(2);
    expect(out.overCap).toBe(true);
    for (let i = 1; i <= 12; i++) expect(text).toContain(`Aufgabe 6 von Stelle ${String(i)}`);
  });

  it('refuses content that fails validation', async () => {
    const [first] = sampleResume.experiences;
    const bad = { ...sampleResume, experiences: [{ ...first, start: '03/2021' }] } as ResumeContent;
    await expect(renderResumePdf(bad)).rejects.toThrow();
  });
});

describe('renderLetterPdf', () => {
  it('writes a one page letter with salutation, paragraphs and sign-off', async () => {
    const out = await renderLetterPdf(sampleLetter);
    const text = (await extractPages(out.pdf)).join(' ');
    expect(out.pages).toBe(1);
    expect((await extractPages(out.pdf)).length).toBe(out.pages);
    expect(out.overCap).toBe(false);
    for (const s of [
      'Mia Müller-Süß',
      'mia.mueller@example.test',
      'Bewerbung als Küchenhilfe',
      'Sehr geehrte Frau Schäfer,',
      'Großküche',
      'Mit freundlichen Grüßen',
      'Brauerei Fröhlich GmbH',
      'Bamberg, 25.11.2026',
    ])
      expect(text).toContain(s);
  });

  it('reports a long letter over the 1 page cap and never cuts content', async () => {
    const long: LetterContent = {
      ...sampleLetter,
      paragraphs: Array.from(
        { length: 12 },
        (_, i) =>
          `Absatz ${String(i + 1)}: ${'Dies ist ein längerer Satz für die Bewerbung. '.repeat(8)}`,
      ),
    };
    const out = await renderLetterPdf(long);
    const text = (await extractPages(out.pdf)).join(' ');
    expect((await extractPages(out.pdf)).length).toBe(out.pages);
    expect(out.pages).toBeGreaterThan(1);
    expect(out.overCap).toBe(true);
    expect(text).toContain('Absatz 12:');
  });
});
