import { describe, expect, it } from 'vitest';
import { cleanBody, isJobLike, narrow, senderDomain, type CandidateJob } from './text';

const job = (id: string, company: string | null, hosts: string[] = []): CandidateJob => ({
  id,
  title: 'Role',
  company,
  hosts,
});

describe('cleanBody', () => {
  it('drops quoted reply text, the reply header and the signature', () => {
    const raw = [
      'Hello,',
      'we would like to invite you.',
      '',
      '> earlier quoted line',
      'On Mon, 3 Nov 2026 at 10:00, Someone <a@example.invalid> wrote:',
      '> more quoted',
      'text below the header',
    ].join('\n');
    expect(cleanBody(raw)).toBe('Hello,\nwe would like to invite you.');
    expect(cleanBody('Thanks.\n-- \nJane Placeholder\nExample GmbH')).toBe('Thanks.');
  });

  it('keeps German reply headers out and caps the length', () => {
    expect(cleanBody('Hallo\nAm 3. Nov. 2026 schrieb Jemand <a@example.invalid>:\nalt')).toBe(
      'Hallo',
    );
    expect(cleanBody('x'.repeat(10_000))).toHaveLength(4000);
  });
});

describe('senderDomain', () => {
  it('reads the domain of a plain or display-name address, lower-cased', () => {
    expect(senderDomain('Jobs Team <Jobs@Mail.Beispiel-Firma.example>')).toBe(
      'mail.beispiel-firma.example',
    );
    expect(senderDomain('a@b.example')).toBe('b.example');
    expect(senderDomain('not an address')).toBeNull();
  });
});

describe('narrow', () => {
  const jobs = [
    job('1', 'Beispiel Firma GmbH', ['careers.beispiel-firma.example']),
    job('2', 'Muster AG'),
    job('3', null, ['boards.greenhouse.io']),
  ];
  const mail = (from: string, subject: string, body = '') => ({ from, subject, body });

  it('matches the sender domain to the company name or a posting host', () => {
    expect(
      narrow(mail('hr@mail.beispiel-firma.example', 'Your application'), jobs).map((j) => j.id),
    ).toEqual(['1']);
    expect(narrow(mail('x@muster.example', 'Hi'), jobs).map((j) => j.id)).toEqual(['2']);
  });

  it('matches a recruiter on a personal address by the company name in the text', () => {
    expect(
      narrow(mail('Pat <pat@gmail.example>', 'Interview', 'I am hiring for Muster AG.'), jobs).map(
        (j) => j.id,
      ),
    ).toEqual(['2']);
  });

  it('for an ATS sender uses the company name, then the ATS posting hosts', () => {
    const ats = 'no-reply@us.greenhouse-mail.io';
    expect(
      narrow(mail(ats, 'Update', 'Thanks from Beispiel Firma'), jobs).map((j) => j.id),
    ).toEqual(['1']);
    expect(narrow(mail(ats, 'Update', 'Thanks from nobody'), jobs).map((j) => j.id)).toEqual(['3']);
  });

  it('returns nothing when nothing fits, and ignores too-short company names', () => {
    expect(narrow(mail('x@unrelated.example', 'Hello'), jobs)).toEqual([]);
    expect(narrow(mail('x@ab.example', 'ab ab'), [job('9', 'AB')])).toEqual([]);
  });
});

describe('isJobLike', () => {
  it('flags application mail in English and German and ATS senders only', () => {
    expect(isJobLike({ from: 'a@b.example', subject: 'Your application', body: '' })).toBe(true);
    expect(isJobLike({ from: 'a@b.example', subject: 'Ihre Bewerbung', body: '' })).toBe(true);
    expect(isJobLike({ from: 'x@jobs.lever.co', subject: 'Hello', body: '' })).toBe(true);
    expect(isJobLike({ from: 'a@b.example', subject: 'Lunch?', body: 'noon' })).toBe(false);
  });
});
