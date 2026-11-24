import { describe, expect, it } from 'vitest';
import { createGmailClient, GmailAuthError, GmailError } from './gmail';
import { createFakeGmail, type FakeMail } from './testing';

const mail = (id: string, over: Partial<FakeMail> = {}): FakeMail => ({
  id,
  from: 'Hiring <hr@example.invalid>',
  subject: 'Subject ' + id,
  body: 'Body ' + id,
  receivedAt: new Date('2026-11-20T10:00:00Z'),
  ...over,
});
const client = (
  fake: ReturnType<typeof createFakeGmail>,
  now = () => new Date('2026-11-24T00:00:00Z'),
) =>
  createGmailClient({
    clientId: 'client-id-placeholder',
    clientSecret: 'client-secret-placeholder',
    refreshToken: 'refresh-token-placeholder',
    fetch: fake.fetch,
    now,
  });

describe('Gmail client against a fake Gmail API', () => {
  it('lists ids across pages from a start instant and fetches one mail as text', async () => {
    const fake = createFakeGmail([
      mail('a', { receivedAt: new Date('2026-11-01T00:00:00Z') }),
      mail('b'),
      mail('c'),
      mail('d'),
    ]);
    const gmail = client(fake);
    const ids = await gmail.listIds(new Date('2026-11-10T00:00:00Z'));
    expect(ids).toEqual(['b', 'c', 'd']);
    expect(fake.requests.filter((r) => r.includes('/messages?'))).toHaveLength(2);
    expect(await gmail.get('b')).toEqual({
      id: 'b',
      from: 'Hiring <hr@example.invalid>',
      subject: 'Subject b',
      text: 'Body b',
      receivedAt: new Date('2026-11-20T10:00:00Z'),
    });
  });

  it('reads an html-only mail as text and never reads an attachment', async () => {
    const fake = createFakeGmail([
      mail('h', {
        html: '<style>p{}</style><p>Dear&nbsp;candidate,</p><p>we &amp; you</p><script>x()</script>',
      }),
      mail('f', { attachment: 'secret attachment text' }),
    ]);
    const gmail = client(fake);
    expect((await gmail.get('h')).text).toBe('Dear candidate,\nwe & you');
    expect((await gmail.get('f')).text).toBe('Body f');
  });

  it('refreshes the access token once and reuses it until it expires', async () => {
    let t = new Date('2026-11-24T00:00:00Z');
    const fake = createFakeGmail([mail('a')]);
    const gmail = client(fake, () => t);
    await gmail.listIds(new Date(0));
    await gmail.get('a');
    expect(fake.tokensIssued).toBe(1);
    t = new Date('2026-11-24T02:00:00Z');
    await gmail.get('a');
    expect(fake.tokensIssued).toBe(2);
  });

  it('raises GmailAuthError for a refused refresh token and for an API that keeps answering 401', async () => {
    const fake = createFakeGmail([mail('a')]);
    fake.tokenMode = 'invalid_grant';
    await expect(client(fake).listIds(new Date(0))).rejects.toBeInstanceOf(GmailAuthError);

    const fake2 = createFakeGmail([mail('a')]);
    fake2.rejectAccessTokens = true;
    await expect(client(fake2).listIds(new Date(0))).rejects.toBeInstanceOf(GmailAuthError);
    // One refresh and one retry, then it gives up.
    expect(fake2.tokensIssued).toBe(2);
  });

  it('raises a plain GmailError, not an auth error, for an outage, and never echoes a secret', async () => {
    const fake = createFakeGmail();
    fake.tokenMode = 'unavailable';
    const err = await client(fake)
      .listIds(new Date(0))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err).not.toBeInstanceOf(GmailAuthError);
    expect((err as Error).message).not.toMatch(/placeholder/);
    const missing = createFakeGmail();
    await expect(client(missing).get('nope')).rejects.toBeInstanceOf(GmailError);
  });
});
