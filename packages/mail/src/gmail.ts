import { z } from 'zod';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
/** The access token is renewed this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

/** The refresh token or the app credentials are refused: the user must sign in again. */
export class GmailAuthError extends Error {
  override name = 'GmailAuthError';
}
/** Any other failure talking to Google: outage, rate limit, network. Retried by the next poll. */
export class GmailError extends Error {
  override name = 'GmailError';
}

export interface GmailMessage {
  id: string;
  from: string;
  /**
   * The domain whose DKIM signature Gmail verified (the topmost Authentication-Results header, added by
   * mx.google.com, has a dkim=pass clause with that header.d), or null. Nothing else in a mail proves who sent it.
   */
  dkimDomain: string | null;
  subject: string;
  /** The text body (plain, else html turned to text); attachments are never read. */
  text: string;
  receivedAt: Date;
}

export interface GmailClient {
  /**
   * Ids of mail received at or after `after` and before `before`, newest first, apart from sent mail and
   * drafts. `truncated` is true when the page cap cut the list: older mail of the window is still unlisted.
   */
  listIds: (after: Date, before?: Date) => Promise<{ ids: string[]; truncated: boolean }>;
  get: (id: string) => Promise<GmailMessage>;
}

export interface GmailOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** List pages (100 ids each) read per call. Default 20. */
  maxPages?: number;
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const listSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});
const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(partSchema).optional(),
  }),
);
const messageSchema = z.object({ id: z.string(), internalDate: z.string(), payload: partSchema });

/**
 * Gmail's own verdict (it writes the topmost Authentication-Results header): the domain of a passing DKIM
 * signature. Read clause by clause: the spf clause carries the envelope sender and other clauses carry text an
 * outside sender controls, so only the clause that starts with dkim=pass counts.
 */
function dkimDomain(headers: { name: string; value: string }[] | undefined): string | null {
  const own = headers?.find((h) => h.name.toLowerCase() === 'authentication-results')?.value;
  // ponytail: trusts the topmost header to be Gmail's; a header an outside sender plants sits below it.
  if (!own) return null;
  // Quoted strings (with escapes) and comments are text an outside sender can shape: drop them before splitting.
  const plain = own.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\((?:\\.|[^()\\])*\)/g, ' ');
  const [id, ...clauses] = plain.split(';');
  if (!/^\s*mx\.google\.com\s*$/i.test(id ?? '')) return null;
  for (const clause of clauses) {
    if (!/^\s*dkim=pass\b/i.test(clause)) continue;
    const d =
      /\bheader\.d=([a-z0-9.-]+)/i.exec(clause)?.[1] ??
      /\bheader\.i=@([a-z0-9.-]+)/i.exec(clause)?.[1];
    if (d) return d.toLowerCase();
  }
  return null;
}

const decode = (data: string): string => Buffer.from(data, 'base64url').toString('utf8');

/** Plain text of an html body: scripts and styles dropped, blocks become lines. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

/** The first body of a mime type outside any attachment. */
function findBody(part: Part, mime: string): string | null {
  if (part.filename) return null;
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findBody(child, mime);
    if (found !== null) return found;
  }
  return null;
}

export function createGmailClient({
  clientId,
  clientSecret,
  refreshToken,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
  maxPages = DEFAULT_MAX_PAGES,
}: GmailOptions): GmailClient {
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // The message never holds the URL or a credential.
      throw new GmailError('request to Google failed');
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > now().getTime()) return token.value;
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
    // 400 invalid_grant and invalid_client mean the refresh token or the app is refused; any other 400 is not.
    const refusal =
      res.status === 400
        ? await res
            .clone()
            .json()
            .catch(() => null)
        : null;
    const refused =
      res.status === 401 ||
      (typeof refusal === 'object' &&
        refusal !== null &&
        'error' in refusal &&
        ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(String(refusal.error)));
    if (refused)
      throw new GmailAuthError('Google refused the refresh token or the app credentials');
    if (!res.ok) throw new GmailError(`token endpoint answered ${String(res.status)}`);
    const parsed = tokenSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new GmailError('token endpoint answered an unexpected body');
    token = {
      value: parsed.data.access_token,
      expiresAt: now().getTime() + parsed.data.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return token.value;
  }

  /** A 403 for a rate or daily limit is an outage, not a lost permission. */
  async function isQuota(res: Response): Promise<boolean> {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    return /ratelimit|dailylimit|quota/i.test(JSON.stringify(body));
  }

  /** GET with the access token; one 401 renews the token and retries, a second one is an auth error. */
  async function api(url: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const res = await call(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
      if (res.status === 401) {
        token = null;
        if (attempt >= 2) throw new GmailAuthError('Gmail kept refusing the access token');
        continue;
      }
      if (res.status === 403 && !(await isQuota(res))) {
        // Insufficient scope or access revoked: signing in again is the fix.
        throw new GmailAuthError('Gmail refused access to the inbox');
      }
      if (!res.ok) throw new GmailError(`Gmail answered ${String(res.status)}`);
      return res.json().catch(() => {
        throw new GmailError('Gmail answered a body that is not JSON');
      });
    }
  }

  return {
    async listIds(after, before) {
      const bound = before ? ` before:${String(Math.floor(before.getTime() / 1000))}` : '';
      const q = `after:${String(Math.floor(after.getTime() / 1000))}${bound} -in:sent -in:drafts -in:spam`;
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({ q, maxResults: String(PAGE_SIZE) });
        if (pageToken) params.set('pageToken', pageToken);
        const parsed = listSchema.safeParse(await api(`${API}?${params.toString()}`));
        if (!parsed.success) throw new GmailError('Gmail listed mail in an unexpected shape');
        ids.push(...(parsed.data.messages ?? []).map((m) => m.id));
        pageToken = parsed.data.nextPageToken;
        if (pageToken === undefined) return { ids, truncated: false };
      }
      return { ids, truncated: true };
    },

    async get(id) {
      const parsed = messageSchema.safeParse(
        await api(`${API}/${encodeURIComponent(id)}?format=full`),
      );
      if (!parsed.success) throw new GmailError('Gmail returned a mail in an unexpected shape');
      const { payload } = parsed.data;
      const header = (name: string): string =>
        payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      const plain = findBody(payload, 'text/plain');
      const html = plain === null ? findBody(payload, 'text/html') : null;
      return {
        id: parsed.data.id,
        from: header('from'),
        dkimDomain: dkimDomain(payload.headers),
        subject: header('subject'),
        text: plain ?? (html === null ? '' : htmlToText(html)),
        receivedAt: new Date(Number(parsed.data.internalDate)),
      };
    },
  };
}
