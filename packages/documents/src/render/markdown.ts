import {
  formatLetterDate,
  formatMonth,
  formatRange,
  labels,
  letterContent,
  newestFirst,
  resumeContent,
  type LetterContent,
  type ResumeContent,
} from './content';

const present = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => Boolean(x));

// Markdown is derived from the structured content, never stored on its own, so it cannot drift from the PDF.
export function resumeMarkdown(input: ResumeContent): string {
  const c = resumeContent.parse(input);
  const l = labels(c.locale);
  const h = c.header;
  const out: string[] = [`# ${h.name}`];
  if (h.headline) out.push(h.headline);
  const contact = present([h.address, h.phone, h.email, ...h.links]);
  if (contact.length) out.push(contact.join(' | '));

  const block = (title: string, lines: string[]) =>
    lines.length && out.push(`\n## ${title}\n${lines.join('\n')}`);
  block(
    l.experience,
    newestFirst(c.experiences).map((e) =>
      [
        `### ${e.role}, ${e.organisation}${e.place ? ` (${e.place})` : ''}`,
        formatRange(e.start, e.end, l.present),
        ...e.points.map((p) => `- ${p}`),
      ].join('\n'),
    ),
  );
  block(
    l.education,
    c.education.map((e) =>
      `- ${e.degree}, ${e.institution}${e.place ? ` (${e.place})` : ''} ${formatRange(e.start, e.end, '')}`.trimEnd(),
    ),
  );
  block(l.skills, c.skills.length ? [c.skills.join(', ')] : []);
  block(
    l.languages,
    c.languages.map((x) => `- ${x.language}: ${x.level}`),
  );
  block(
    l.certificates,
    c.certificates.map(
      (x) =>
        `- ${x.name}${x.issuer ? `, ${x.issuer}` : ''}${x.date ? ` (${formatMonth(x.date)})` : ''}`,
    ),
  );
  return out.join('\n') + '\n';
}

export function letterMarkdown(input: LetterContent): string {
  const c = letterContent.parse(input);
  const s = c.sender;
  const r = c.recipient;
  return (
    [
      present([s.name, s.address, s.phone, s.email]).join('\n'),
      present([r.company, r.contact, r.address]).join('\n'),
      formatLetterDate(c.date, c.place),
      `**${c.subject}**`,
      c.salutation,
      ...c.paragraphs,
      c.signOff,
      c.signature,
    ].join('\n\n') + '\n'
  );
}
