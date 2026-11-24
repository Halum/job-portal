import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfmake, { type Content, type TDocumentDefinitions } from 'pdfmake';
import { checkPhoto } from './image';
import {
  LETTER_PAGE_CAP,
  RESUME_PAGE_CAP,
  formatLetterDate,
  certificateLine,
  inPlace,
  present,
  formatRange,
  labels,
  letterContent,
  newestFirst,
  resumeContent,
  type LetterContent,
  type ResumeContent,
} from './content';

export interface RenderedPdf {
  pdf: Buffer;
  pages: number;
  // True when the document is longer than its cap. The content is never cut; the caller decides what to trim.
  overCap: boolean;
}

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fonts');
const REGULAR = path.join(FONT_DIR, 'Roboto-Regular.ttf');
const MEDIUM = path.join(FONT_DIR, 'Roboto-Medium.ttf');

// ponytail: one process-wide pdfmake instance; fine while the layout is the only one.
pdfmake.addFonts({
  Roboto: { normal: REGULAR, bold: MEDIUM, italics: REGULAR, bolditalics: MEDIUM },
});
// Only the bundled font files may be read from disk; images arrive as data URIs.
// No remote fetching at all.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p: string) => path.dirname(path.resolve(p)) === FONT_DIR);

const ACCENT = '#1f3a5f';
const MARGINS: [number, number, number, number] = [50, 45, 50, 45];

async function build(definition: TDocumentDefinitions, cap: number): Promise<RenderedPdf> {
  let pages = 0;
  const pdf = await pdfmake
    .createPdf({
      ...definition,
      defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.2 },
      pageSize: 'A4',
      pageMargins: MARGINS,
      // The footer callback is the one place pdfmake reports the final page count.
      footer: (_current: number, count: number) => {
        pages = count;
        return null;
      },
    })
    .getBuffer();
  return { pdf: Buffer.from(pdf), pages, overCap: pages > cap };
}

function section(title: string, body: Content[]): Content[] {
  return body.length === 0 ? [] : [{ text: title.toUpperCase(), style: 'section' }, ...body];
}

const styles: TDocumentDefinitions['styles'] = {
  name: { fontSize: 20, bold: true, color: ACCENT },
  section: { fontSize: 11, bold: true, color: ACCENT, margin: [0, 12, 0, 4] },
  title: { bold: true },
  muted: { color: '#555555' },
};

export interface ResumeOptions {
  // PNG or JPEG bytes; the photo is drawn only when given.
  photo?: Buffer;
}

export async function renderResumePdf(
  input: ResumeContent,
  options: ResumeOptions = {},
): Promise<RenderedPdf> {
  const c = resumeContent.parse(input);
  const l = labels(c.locale);
  const h = c.header;
  const contact = present([h.address, h.phone, h.email, ...h.links]);
  const headerText: Content = {
    stack: [
      { text: h.name, style: 'name' },
      ...(h.headline
        ? [
            {
              text: h.headline,
              style: 'muted',
              margin: [0, 2, 0, 4] as [number, number, number, number],
            },
          ]
        : []),
      { text: contact.join('  |  '), style: 'muted' },
    ],
  };
  const header: Content = options.photo
    ? {
        columns: [
          headerText,
          { image: photoDataUri(options.photo), width: 70, alignment: 'right' },
        ],
        columnGap: 10,
      }
    : headerText;

  const experiences = newestFirst(c.experiences).map((e): Content => ({
    margin: [0, 0, 0, 6],
    stack: [
      {
        columns: [
          {
            text: [
              { text: e.role, style: 'title' },
              { text: `, ${e.organisation}${inPlace(e.place)}` },
            ],
          },
          {
            text: formatRange(e.start, e.end, l.present),
            style: 'muted',
            alignment: 'right',
            width: 'auto',
          },
        ],
      },
      ...(e.points.length
        ? [{ ul: e.points, margin: [8, 2, 0, 0] as [number, number, number, number] }]
        : []),
    ],
  }));
  const education = c.education.map((e): Content => ({
    margin: [0, 0, 0, 4],
    columns: [
      {
        text: [
          { text: e.degree, style: 'title' },
          { text: `, ${e.institution}${inPlace(e.place)}` },
        ],
      },
      { text: formatRange(e.start, e.end, ''), style: 'muted', alignment: 'right', width: 'auto' },
    ],
  }));
  const languages = c.languages.map((x): Content => ({ text: `${x.language}: ${x.level}` }));
  const certificates = c.certificates.map((x): Content => ({ text: certificateLine(x) }));

  return build(
    {
      info: { title: h.name, author: h.name },
      styles,
      content: [
        header,
        ...section(l.experience, experiences),
        ...section(l.education, education),
        ...section(l.skills, c.skills.length ? [{ text: c.skills.join(', ') }] : []),
        ...section(l.languages, languages),
        ...section(l.certificates, certificates),
      ],
    },
    RESUME_PAGE_CAP,
  );
}

function photoDataUri(photo: Buffer): string {
  const { type } = checkPhoto(photo);
  return `data:image/${type};base64,${photo.toString('base64')}`;
}

export async function renderLetterPdf(input: LetterContent): Promise<RenderedPdf> {
  const c = letterContent.parse(input);
  const s = c.sender;
  const r = c.recipient;
  const dateText = formatLetterDate(c.date, c.place);
  const lines = (xs: (string | null | undefined)[]): Content[] =>
    present(xs).map((text) => ({ text }));
  return build(
    {
      info: { title: c.subject, author: s.name },
      styles,
      content: [
        {
          stack: [
            { text: s.name, style: 'name' },
            ...present([s.address, s.phone, s.email]).map((text): Content => ({
              text,
              style: 'muted',
            })),
          ],
        },
        { stack: lines([r.company, r.contact, r.address]), margin: [0, 24, 0, 0] },
        { text: dateText, alignment: 'right', margin: [0, 12, 0, 12] },
        { text: c.subject, style: 'title', margin: [0, 0, 0, 12] },
        { text: c.salutation, margin: [0, 0, 0, 8] },
        ...c.paragraphs.map((text): Content => ({
          text,
          margin: [0, 0, 0, 8],
          alignment: 'justify',
        })),
        { text: c.signOff, margin: [0, 8, 0, 24] },
        { text: c.signature },
      ],
    },
    LETTER_PAGE_CAP,
  );
}
