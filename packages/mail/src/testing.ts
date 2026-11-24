/** A fake Gmail and OAuth server at HTTP level, for tests. Synthetic mails only. */
export interface FakeMail {
  id: string;
  from: string;
  subject: string;
  /** The text/plain body. */
  body: string;
  /** When set, the mail has only this text/html body and no plain part. */
  html?: string;
  receivedAt: Date;
  /** A part with a file name, which the reader must skip. */
  attachment?: string;
  /**
   * The Authentication-Results header Gmail adds: a string is used as it is, null means none. By default Gmail
   * reports dmarc=pass for the domain of From.
   */
  authResults?: string | null;
}

export interface FakeGmail {
  fetch: typeof fetch;
  mails: FakeMail[];
  /** How the token endpoint answers: ok, an invalid_grant 400, any other 400, or a 503. */
  tokenMode: 'ok' | 'invalid_grant' | 'bad_request' | 'unavailable';
  /** Ids whose message read answers 500, as a mail Gmail cannot serve right now. */
  failIds: string[];
  /** When true, a list that asks for older mail (a before: bound) answers 500. */
  failBefore: boolean;
  /** When set, the Gmail API answers every request with this status and Google-style error reason. */
  apiError: { status: number; reason: string } | null;
  /** When true the API answers 401 to every request, whatever the token. */
  rejectAccessTokens: boolean;
  /** Every request as "METHOD url". */
  requests: string[];
  /** Mail ids whose full message was fetched. */
  fetched: string[];
  tokensIssued: number;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const payload = (m: FakeMail): object => {
  const address = /<([^<>]*)>\s*$/.exec(m.from)?.[1] ?? m.from;
  const domain =
    /@([a-z0-9.-]+)\s*$/i.exec(address.trim())?.[1]?.toLowerCase() ?? 'unknown.invalid';
  const auth =
    m.authResults === undefined
      ? `mx.google.com; dkim=pass header.i=@${domain} header.d=${domain}; spf=pass; dmarc=pass (p=NONE) header.from=${domain}`
      : m.authResults;
  const headers = [
    ...(auth === null ? [] : [{ name: 'Authentication-Results', value: auth }]),
    { name: 'From', value: m.from },
    { name: 'Subject', value: m.subject },
  ];
  const text =
    m.html === undefined
      ? { mimeType: 'text/plain', body: { data: b64(m.body) } }
      : { mimeType: 'text/html', body: { data: b64(m.html) } };
  const parts =
    m.attachment === undefined
      ? [text]
      : [
          text,
          {
            mimeType: 'text/plain',
            filename: 'cv.txt',
            body: { data: b64(m.attachment) },
          },
        ];
  return { headers, mimeType: 'multipart/mixed', parts };
};

export function createFakeGmail(mails: FakeMail[] = []): FakeGmail {
  const fake: FakeGmail = {
    mails,
    tokenMode: 'ok',
    apiError: null,
    failIds: [],
    failBefore: false,
    rejectAccessTokens: false,
    requests: [],
    fetched: [],
    tokensIssued: 0,
    fetch: (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      fake.requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}${url.search}`);
      if (url.hostname === 'oauth2.googleapis.com') {
        if (fake.tokenMode === 'invalid_grant') {
          return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
        }
        if (fake.tokenMode === 'bad_request') {
          return Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 400 }));
        }
        if (fake.tokenMode === 'unavailable')
          return Promise.resolve(new Response('', { status: 503 }));
        fake.tokensIssued += 1;
        return Promise.resolve(
          Response.json({ access_token: `token-${String(fake.tokensIssued)}`, expires_in: 3600 }),
        );
      }
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (fake.rejectAccessTokens || !auth.startsWith('Bearer token-')) {
        return Promise.resolve(new Response('', { status: 401 }));
      }
      if (fake.apiError) {
        return Promise.resolve(
          Response.json(
            { error: { errors: [{ reason: fake.apiError.reason }] } },
            { status: fake.apiError.status },
          ),
        );
      }
      const single = /\/messages\/([^/]+)$/.exec(url.pathname);
      if (single?.[1]) {
        if (fake.failIds.includes(single[1])) {
          return Promise.resolve(new Response('', { status: 500 }));
        }
        const m = fake.mails.find((x) => x.id === single[1]);
        if (!m) return Promise.resolve(new Response('', { status: 404 }));
        fake.fetched.push(m.id);
        return Promise.resolve(
          Response.json({
            id: m.id,
            internalDate: String(m.receivedAt.getTime()),
            payload: payload(m),
          }),
        );
      }
      if (fake.failBefore && /before:/.test(url.searchParams.get('q') ?? '')) {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      const after = /after:(\d+)/.exec(url.searchParams.get('q') ?? '');
      const since = after?.[1] ? Number(after[1]) * 1000 : 0;
      const until =
        Number(/before:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1] ?? Infinity) * 1000;
      // Gmail lists newest first.
      const all = fake.mails
        .filter((m) => m.receivedAt.getTime() >= since && m.receivedAt.getTime() < until)
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      const start = Number(url.searchParams.get('pageToken') ?? '0');
      const page = all.slice(start, start + 2);
      return Promise.resolve(
        Response.json({
          messages: page.map((m) => ({ id: m.id })),
          ...(start + 2 < all.length ? { nextPageToken: String(start + 2) } : {}),
        }),
      );
    },
  };
  return fake;
}
