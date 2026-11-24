import { z } from 'zod';

// Structured resume and cover letter content: what the skill saves in an Application packet and what the renderer draws.
// Caps keep one request from carrying an unbounded document; the page caps below are about layout, not size.
const line = z.string().trim().min(1).max(300);
const text = z.string().trim().min(1).max(2000);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM');
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'use YYYY-MM-DD');

export const LOCALES = ['de', 'en'] as const;
const locale = z.enum(LOCALES);

const contact = z.object({
  name: line,
  address: line.nullish(),
  phone: line.nullish(),
  email: line.nullish(),
});

export const resumeContent = z.object({
  locale,
  header: contact.extend({
    headline: line.nullish(),
    links: z.array(line).max(10).default([]),
  }),
  experiences: z
    .array(
      z.object({
        role: line,
        organisation: line,
        place: line.nullish(),
        start: month,
        // null means the role is current
        end: month.nullable(),
        points: z.array(text).max(20),
      }),
    )
    .max(30),
  education: z
    .array(
      z.object({
        degree: line,
        institution: line,
        place: line.nullish(),
        start: month.nullish(),
        end: month.nullish(),
      }),
    )
    .max(20)
    .default([]),
  skills: z.array(line).max(60).default([]),
  languages: z
    .array(z.object({ language: line, level: line }))
    .max(20)
    .default([]),
  certificates: z
    .array(z.object({ name: line, issuer: line.nullish(), date: month.nullish() }))
    .max(30)
    .default([]),
});
export type ResumeContent = z.input<typeof resumeContent>;

export const letterContent = z.object({
  locale,
  sender: contact,
  recipient: z.object({ company: line, contact: line.nullish(), address: line.nullish() }),
  place: line.nullish(),
  date: day,
  subject: line,
  salutation: line,
  paragraphs: z.array(text).min(1).max(20),
  signOff: line,
  signature: line,
});
export type LetterContent = z.input<typeof letterContent>;

export const RESUME_PAGE_CAP = 2;
export const LETTER_PAGE_CAP = 1;

const LABELS = {
  de: {
    experience: 'Berufserfahrung',
    education: 'Ausbildung',
    skills: 'Kenntnisse',
    languages: 'Sprachen',
    certificates: 'Zertifikate',
    present: 'heute',
    subject: 'Betreff',
  },
  en: {
    experience: 'Work experience',
    education: 'Education',
    skills: 'Skills',
    languages: 'Languages',
    certificates: 'Certificates',
    present: 'present',
    subject: 'Subject',
  },
} as const;
export function labels(l: (typeof LOCALES)[number]) {
  return LABELS[l];
}

// 2021-03 becomes 03/2021
export function formatMonth(value: string): string {
  return `${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

export function formatRange(
  start: string | null | undefined,
  end: string | null | undefined,
  present: string,
): string {
  const from = start ? formatMonth(start) : '';
  const to = end ? formatMonth(end) : start ? present : '';
  return from && to ? `${from} - ${to}` : from || to;
}

// 2026-11-25 becomes 25.11.2026, prefixed with the place when there is one
export function formatLetterDate(date: string, place?: string | null): string {
  return `${place ? `${place}, ` : ''}${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}

// Drops empty parts so a missing address or phone leaves no gap
export function present(xs: (string | null | undefined)[]): string[] {
  return xs.filter((x): x is string => Boolean(x));
}

// "Bamberg" becomes " (Bamberg)", nothing becomes ""
export function inPlace(place: string | null | undefined): string {
  return place ? ` (${place})` : '';
}

// "Hygiene course, Health office (05/2020)"
export function certificateLine(x: {
  name: string;
  issuer?: string | null;
  date?: string | null;
}): string {
  return `${x.name}${x.issuer ? `, ${x.issuer}` : ''}${x.date ? ` (${formatMonth(x.date)})` : ''}`;
}

// Newest first: current roles lead, then by end month, then by start month.
export function newestFirst<T extends { start: string; end: string | null }>(
  experiences: T[],
): T[] {
  return [...experiences].sort((a, b) => {
    const byEnd = (b.end ?? '9999-99').localeCompare(a.end ?? '9999-99');
    return byEnd !== 0 ? byEnd : b.start.localeCompare(a.start);
  });
}
