/** What narrowing and the classifier see of one mail: text only, no attachments. */
export interface MailText {
  from: string;
  subject: string;
  body: string;
}

/** A Job a reply may belong to (not a Matching Candidate), reduced to what narrowing needs. */
export interface ReplyCandidate {
  id: string;
  title: string;
  company: string | null;
  /** Hosts of the posting links, such as careers.example.invalid. */
  hosts: string[];
}

const MAX_BODY = 4000;
const MAX_CANDIDATES = 10;
const MIN_KEY = 4;

/** Mail from these applicant tracking systems names the company in its text, not in its address. */
const ATS_DOMAINS = [
  'greenhouse.io',
  'greenhouse-mail.io',
  'lever.co',
  'ashbyhq.com',
  'smartrecruiters.com',
  'personio.de',
  'personio.com',
  'workable.com',
  'join.com',
  'teamtailor.com',
  'recruitee.com',
  'softgarden.io',
  'rexx-systems.com',
  'bamboohr.com',
];

/** Labels that say what a mailbox is for and never name the company. */
const GENERIC = new Set([
  'mail',
  'mails',
  'email',
  'jobs',
  'careers',
  'karriere',
  'hr',
  'recruiting',
  'noreply',
  'www',
]);

const LEGAL = /\b(gmbh|ag|se|kg|ug|inc|ltd|llc|co|corp|mbh|ohg|e\.?v)\b\.?/gi;
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The text of a mail without quoted replies, the reply header and the signature, capped. */
export function cleanBody(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const [i, line] of lines.entries()) {
    const next = lines[i + 1] ?? '';
    const header =
      /^on\b.*wrote:\s*$/i.test(line) ||
      (/^on\b/i.test(line) && /wrote:\s*$/i.test(next)) ||
      /^am\b.*schrieb.*:\s*$/i.test(line) ||
      /^-+\s*original message/i.test(line);
    if (header || /^--\s?$/.test(line)) break;
    if (!line.startsWith('>')) kept.push(line);
  }
  return kept.join('\n').trim().slice(0, MAX_BODY);
}

/** The lower-cased domain of the address in a From header (the one inside <...>, never the display name), or null. */
export function senderDomain(from: string): string | null {
  const address = /<([^<>]*)>\s*$/.exec(from)?.[1] ?? from;
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(address.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** True when `domain` is `parent` or one of its subdomains. */
export const withinDomain = (domain: string, parent: string): boolean =>
  domain === parent || domain.endsWith(`.${parent}`);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/**
 * The domain a company owns behind a host: its last two labels, three under a country second level such as
 * co.uk. ponytail: no public suffix list; an unlisted multi-part suffix is the known ceiling.
 */
function ownedDomain(host: string): string {
  const labels = host.toLowerCase().split('.');
  const n =
    labels[labels.length - 1]?.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2] ?? '')
      ? 3
      : 2;
  return labels.slice(-n).join('.');
}

const isAts = (domain: string): boolean =>
  ATS_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));

/** The name part of a domain (the label before the top level), or null for a generic one. */
function brand(domain: string): string | null {
  const labels = domain.split('.');
  const label = labels.length >= 2 ? labels[labels.length - 2] : undefined;
  return label && !GENERIC.has(label) ? norm(label) : null;
}

const companyKey = (company: string | null): string | null => {
  const key = company === null ? '' : norm(company.replace(LEGAL, ''));
  return key.length >= MIN_KEY ? key : null;
};

const displayName = (from: string): string => from.replace(/<[^>]*>/g, ' ');

/** A reply candidate with whether the sender's own domain belongs to the Job's company (not only a name in the text). */
export type NarrowedCandidate = ReplyCandidate & { strong: boolean };

/**
 * Jobs the mail may belong to: by sender domain, company name in the text, and ATS senders. `strong` marks the
 * ones the sender's domain (or an ATS sender) backs; a name in text anyone can write is weak.
 */
export function narrow(mail: MailText, jobs: ReplyCandidate[]): NarrowedCandidate[] {
  const domain = senderDomain(mail.from);
  const ats = domain !== null && isAts(domain);
  const senderBrand = domain === null || ats ? null : brand(domain);
  const text = norm(`${displayName(mail.from)} ${mail.subject} ${mail.body}`);
  const scored = jobs.flatMap((job) => {
    const key = companyKey(job.company);
    const byName = key !== null && text.includes(key);
    const byDomain =
      senderBrand !== null &&
      senderBrand.length >= MIN_KEY &&
      ((key !== null && (key.includes(senderBrand) || senderBrand.includes(key))) ||
        job.hosts.some((h) => !isAts(h) && brand(h) === senderBrand));
    // Strong (what may apply without a human) is stricter than a fit: the sender's domain is, or sits under, a
    // domain the Job's own non-ATS posting host belongs to. A lookalike domain or an ATS sender is never strong.
    const strong =
      !ats &&
      domain !== null &&
      job.hosts.some((h) => !isAts(h) && withinDomain(domain, ownedDomain(h)));
    return byName || byDomain ? [{ job, strong, score: Number(byName) + Number(byDomain) }] : [];
  });
  if (scored.length === 0 && ats) {
    // Any Job posted on that ATS: too loose to trust on its own.
    return jobs
      .filter((j) => j.hosts.some(isAts))
      .slice(0, MAX_CANDIDATES)
      .map((job) => ({ ...job, strong: false }));
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ ...s.job, strong: s.strong }))
    .slice(0, MAX_CANDIDATES);
}

const JOB_WORDS =
  /application|apply|applied|interview|position|vacanc|candidate|recruit|hiring|job offer|offer letter|bewerbung|stelle|vorstellungsgespr|absage|zusage|kandidat/i;

/** A mail worth keeping when it matches no Job: job words, or an ATS sender. */
export function isJobLike(mail: MailText): boolean {
  const domain = senderDomain(mail.from);
  return (domain !== null && isAts(domain)) || JOB_WORDS.test(`${mail.subject}\n${mail.body}`);
}
