import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import {
  createNotifications,
  notificationsMigrations,
  type JobInfo,
  type NewTagInput,
  type Notifications,
} from './index';

const TOPIC = 'topic-placeholder';
const T1 = '00000000-0000-4000-8000-000000000401';
const T2 = '00000000-0000-4000-8000-000000000402';
const J = (n: number): string => `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`;
let userCounter = 0;
const newUser = (): string => {
  userCounter += 1;
  return `00000000-0000-4000-8000-0000000007${String(userCounter).padStart(2, '0')}`;
};
const tag = (job: number, over: Partial<NewTagInput> = {}): NewTagInput => ({
  jobId: J(job),
  targetId: T1,
  targetName: 'alpha',
  score: 85,
  reasons: ['fits the stack', 'near home'],
  override: false,
  ...over,
});
const NONE = { failing: [], checked: [] };

describe('notifications against real Postgres and a fake webhook', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let server: http.Server;
  let url: string;
  /** Every body the fake webhook received, in order. */
  let received: { kind: string; text: string; topicId: string }[];
  /** Answers per request: the status code to return; the last one repeats. */
  let statuses: number[];
  let tags: NewTagInput[];
  let pending: number;
  let sleeps: number[];
  /** The "since" each newTags call got. */
  let sinces: Date[];
  let failJobInfo = false;
  /** Message kinds the fake webhook rejects with a 400. */
  const rejectKinds = new Set<string>();
  const jobs = new Map<string, JobInfo | null>();

  const make = (maxAttempts = 3): Notifications =>
    createNotifications(handle.db, {
      newTags: (_u, since) => {
        sinces.push(since);
        return Promise.resolve(tags);
      },
      jobInfo: (_u, id) =>
        failJobInfo
          ? Promise.reject(new Error('lookup failed'))
          : Promise.resolve(
              jobs.has(id)
                ? (jobs.get(id) ?? null)
                : {
                    title: `Role ${id.slice(-2)}`,
                    company: 'Beispiel Firma',
                    links: ['https://example.invalid/j/' + id.slice(-2)],
                    active: true,
                  },
            ),
      pendingReviews: () => Promise.resolve(pending),
      webhook: { url, topicId: TOPIC },
      maxAttempts,
      backoffMs: 10,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
  const digests = (): typeof received => received.filter((m) => m.kind === 'digest');
  const alerts = (): typeof received => received.filter((m) => m.kind === 'alert');
  const since = new Date(0);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [notificationsMigrations]);
    handle = createDb(container.getConnectionUri());
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as (typeof received)[number];
        const status = rejectKinds.has(parsed.kind)
          ? 400
          : statuses.length > 1
            ? (statuses.shift() ?? 200)
            : (statuses[0] ?? 200);
        if (status === 200) received.push(parsed);
        else received.push({ kind: 'failed-request', text: '', topicId: '' });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`;
  });
  afterAll(async () => {
    server.close();
    await handle.close();
    await container.stop();
  });
  beforeEach(() => {
    received = [];
    statuses = [200];
    tags = [];
    pending = 0;
    sleeps = [];
    sinces = [];
    failJobInfo = false;
    rejectKinds.clear();
    jobs.clear();
  });

  it('sends nothing and stores nothing when nothing is new', async () => {
    const user = newUser();
    const result = await make().afterRun(user, { since, ...NONE });
    expect(received).toEqual([]);
    expect(result).toEqual({ digestSent: false, alertsSent: 0, unsent: 0 });
  });

  it('sends one digest per run with title, company, Target tags, score, reasons, links and the waiting Review count', async () => {
    const user = newUser();
    tags = [
      tag(1),
      tag(1, { targetId: T2, targetName: 'beta', score: 72, reasons: ['ok'] }),
      tag(2),
    ];
    pending = 3;
    const result = await make().afterRun(user, { since, ...NONE });
    expect(result).toEqual({ digestSent: true, alertsSent: 0, unsent: 0 });
    expect(digests()).toHaveLength(1);
    const [d] = digests();
    expect(d?.topicId).toBe(TOPIC);
    for (const part of [
      'Role 01',
      'Role 02',
      'Beispiel Firma',
      'alpha',
      'beta',
      '85',
      '72',
      'fits the stack',
      'near home',
      'https://example.invalid/j/01',
      'Review waiting: 3',
    ])
      expect(d?.text).toContain(part);
  });

  it('lists a (Job, Target) pair once ever; a new Target for the same Job is still new', async () => {
    const user = newUser();
    tags = [tag(1)];
    await make().afterRun(user, { since, ...NONE });
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(1);
    tags = [tag(1), tag(1, { targetId: T2, targetName: 'beta' })];
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(2);
    expect(digests()[1]?.text).toContain('beta');
    expect(digests()[1]?.text).not.toContain('alpha');
  });

  it('lists a tag override in the next digest and marks it as an override', async () => {
    const user = newUser();
    tags = [tag(1)];
    await make().afterRun(user, { since, ...NONE });
    tags = [tag(1), tag(2, { score: 40, override: true, reasons: ['too far'] })];
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(2);
    expect(digests()[1]?.text).toContain('Role 02');
    expect(digests()[1]?.text).toContain('override');
    expect(digests()[1]?.text).not.toContain('Role 01');
  });

  it('skips a Job that is gone or not active at this look-up, and lists one that turns up at a later look-up', async () => {
    const user = newUser();
    jobs.set(J(1), null);
    jobs.set(J(2), { title: 'Dismissed role', company: null, links: [], active: false });
    tags = [tag(1), tag(2)];
    await make().afterRun(user, { since, ...NONE });
    expect(received).toEqual([]);
    jobs.delete(J(1));
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(1);
    expect(digests()[0]?.text).toContain('Role 01');
  });

  it('retries with growing backoff and sends once the webhook answers', async () => {
    const user = newUser();
    statuses = [500, 500, 200];
    tags = [tag(1)];
    const result = await make().afterRun(user, { since, ...NONE });
    expect(result).toMatchObject({ digestSent: true, unsent: 0 });
    expect(received.filter((m) => m.kind === 'failed-request')).toHaveLength(2);
    expect(digests()).toHaveLength(1);
    expect(sleeps).toEqual([10, 20]);
    // A webhook that recovered inside the retries is not a failure type.
    expect(alerts()).toEqual([]);
  });

  it('after the last retry keeps the digest unsent and folds it into the next digest', async () => {
    const user = newUser();
    statuses = [500];
    tags = [tag(1)];
    const failed = await make().afterRun(user, { since, ...NONE });
    expect(failed).toMatchObject({ digestSent: false, unsent: 2 });
    expect(received.filter((m) => m.kind === 'failed-request')).toHaveLength(3);
    expect(digests()).toEqual([]);

    // The webhook is back and a run finds one more Job: one message holds both.
    statuses = [200];
    received = [];
    tags = [tag(1), tag(2)];
    const next = await make().afterRun(user, { since, ...NONE });
    expect(next).toMatchObject({ digestSent: true, unsent: 0 });
    expect(digests()).toHaveLength(1);
    expect(digests()[0]?.text).toContain('Role 01');
    expect(digests()[0]?.text).toContain('Role 02');
    // The webhook failure is an alert type: one when it started failing, one when it recovered.
    expect(alerts().map((a) => a.text.toLowerCase())).toEqual([
      expect.stringContaining('failing'),
      expect.stringContaining('recovered'),
    ]);
  });

  it('with nothing new it still retries an unsent digest', async () => {
    const user = newUser();
    statuses = [500];
    tags = [tag(1)];
    await make(1).afterRun(user, { since, ...NONE });
    statuses = [200];
    received = [];
    const result = await make().afterRun(user, { since, ...NONE });
    expect(result.digestSent).toBe(true);
    expect(digests()).toHaveLength(1);
    expect(digests()[0]?.text).toContain('Role 01');
  });

  it('sends a failure alert once when a type starts failing and once when it recovers', async () => {
    const user = newUser();
    const n = make();
    const failing = { failing: ['board:greenhouse:acme'], checked: ['board:greenhouse:'] };
    expect((await n.afterRun(user, { since, ...failing })).alertsSent).toBe(1);
    expect((await n.afterRun(user, { since, ...failing })).alertsSent).toBe(0);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.text).toContain('board greenhouse acme');

    // A run that did not check this type neither recovers it nor repeats the alert.
    await n.afterRun(user, { since, failing: [], checked: ['source:other'] });
    expect(alerts()).toHaveLength(1);

    expect(
      (await n.afterRun(user, { since, failing: [], checked: ['board:greenhouse:'] })).alertsSent,
    ).toBe(1);
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]?.text.toLowerCase()).toContain('recovered');
    await n.afterRun(user, { since, failing: [], checked: ['board:greenhouse:'] });
    expect(alerts()).toHaveLength(2);

    // Failing again after a recovery starts a new alert.
    await n.afterRun(user, { since, ...failing });
    expect(alerts()).toHaveLength(3);
  });

  it('keys alerts per type: two types alert separately', async () => {
    const user = newUser();
    await make().afterRun(user, {
      since,
      failing: ['source:bambase', 'ai:openrouter:rate_limit'],
      checked: [],
    });
    expect(alerts()).toHaveLength(2);
  });

  it('keeps users apart: pairs, failures and unsent messages of one user do not touch another', async () => {
    const a = newUser();
    const b = newUser();
    tags = [tag(1)];
    const failing = { failing: ['source:bambase'], checked: [] };
    await make().afterRun(a, { since, ...failing });
    await make().afterRun(b, { since, ...failing });
    expect(digests()).toHaveLength(2);
    expect(alerts()).toHaveLength(2);
    await make().afterRun(a, { since, failing: [], checked: ['source:bambase'] });
    expect(alerts()).toHaveLength(3);
    await make().afterRun(b, { since, failing: [], checked: ['source:bambase'] });
    expect(alerts()).toHaveLength(4);
  });

  it('two workers finishing runs at once send one digest and one alert', async () => {
    const user = newUser();
    tags = [tag(1)];
    const input = { since, failing: ['source:bambase'], checked: [] };
    await Promise.all([make().afterRun(user, input), make().afterRun(user, input)]);
    expect(digests()).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
  });

  const bigJob = (n: number): void => {
    jobs.set(J(n), {
      title: `Job ${String(n)} ${'T'.repeat(90)}`,
      company: 'C'.repeat(50),
      links: [
        `https://example.invalid/${'a'.repeat(150)}/${String(n)}`,
        'https://example.invalid/second',
      ],
      active: true,
    });
  };
  const longTag = (job: number, over: Partial<NewTagInput> = {}): NewTagInput =>
    tag(job, { reasons: ['r1', 'r2', 'r3'].map((r) => `${r} ${'x'.repeat(115)}`), ...over });
  const occurrences = (text: string, part: string): number => text.split(part).length - 1;

  it('splits a long digest into messages under 4096 characters, whole Jobs only, the Review count on the last', async () => {
    const user = newUser();
    pending = 7;
    tags = [];
    for (let n = 1; n <= 80; n += 1) {
      bigJob(n);
      tags.push(longTag(n, { score: 100 - (n % 30) }));
    }
    await make().afterRun(user, { since, ...NONE });
    const texts = digests().map((d) => d.text);
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t.length).toBeLessThan(4096);
    const all = texts.join('\n');
    for (let n = 1; n <= 80; n += 1) expect(occurrences(all, `Job ${String(n)} T`)).toBe(1);
    expect(texts[0]).toContain(`part 1 of ${String(texts.length)}`);
    expect(texts.filter((t) => t.includes('Review waiting: 7'))).toEqual([texts.at(-1)]);
    // Each Job's lines stay together: its link follows its title in the same message.
    for (const t of texts)
      expect(occurrences(t, 'https://example.invalid/second')).toBe(occurrences(t, ' at '));
  });

  it('counts a message as sent only when it got a 2xx: the rest wait and go out once, never twice', async () => {
    const user = newUser();
    tags = [];
    for (let n = 1; n <= 30; n += 1) {
      bigJob(n);
      tags.push(longTag(n));
    }
    statuses = [200, 500];
    const first = await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(1);
    const chunks = 1 + (first.unsent - 1); // the unsent ones, minus the webhook failure alert
    expect(chunks).toBeGreaterThan(2);

    statuses = [200];
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(chunks);
    const all = digests()
      .map((d) => d.text)
      .join('\n');
    for (let n = 1; n <= 30; n += 1) expect(occurrences(all, `Job ${String(n)} T`)).toBe(1);
  });

  it('cuts the reasons of one oversized Job and keeps its links', async () => {
    const user = newUser();
    bigJob(1);
    tags = Array.from({ length: 30 }, (_, i) =>
      longTag(1, {
        targetId: `00000000-0000-4000-8000-0000000008${String(10 + i)}`,
        targetName: `target ${String(i)}`,
      }),
    );
    await make().afterRun(user, { since, ...NONE });
    expect(digests()).toHaveLength(1);
    const text = digests()[0]?.text ?? '';
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('https://example.invalid/second');
    expect(text).toContain('Job 1 T');
    expect(text).not.toContain('r1 xxx');
  });

  it('an alert is not held back by a digest the webhook rejects, and a rejection is not retried', async () => {
    const user = newUser();
    rejectKinds.add('digest');
    tags = [tag(1)];
    const first = await make().afterRun(user, { since, ...NONE });
    expect(first).toMatchObject({ digestSent: false, unsent: 1 });
    expect(received.filter((m) => m.kind === 'failed-request')).toHaveLength(1);

    tags = [];
    const second = await make().afterRun(user, {
      since,
      failing: ['source:bambase'],
      checked: [],
    });
    expect(second).toMatchObject({ alertsSent: 1, digestSent: false, unsent: 1 });
    expect(alerts()).toHaveLength(1);
  });

  it('loses nothing when a run fails before its digest is stored: the next run looks up from the same watermark', async () => {
    const user = newUser();
    const first = new Date(Date.now() - 3 * 3600_000);
    tags = [tag(1)];
    failJobInfo = true;
    await expect(make().afterRun(user, { since: first, ...NONE })).rejects.toThrow('lookup failed');
    failJobInfo = false;
    await make().afterRun(user, { since: new Date(), ...NONE });
    expect(sinces[0]).toEqual(first);
    expect(sinces[1]).toEqual(first);
    expect(digests()).toHaveLength(1);
    // Stored: the watermark moves on, so the next run looks only at newer scores.
    await make().afterRun(user, { since: new Date(), ...NONE });
    expect((sinces[2] ?? first).getTime()).toBeGreaterThan(first.getTime());
  });

  it('sendLines sends each short line as its own message of kind line, before a waiting digest', async () => {
    const user = newUser();
    rejectKinds.add('digest');
    tags = [tag(1)];
    await make().afterRun(user, { since, ...NONE });
    rejectKinds.clear();
    received = [];
    await make().sendLines(user, ['Gone cold: Role A at Firma X, 14 days', 'Rejected: Role B']);
    expect(received.map((m) => [m.kind, m.text, m.topicId])).toEqual([
      ['line', 'Gone cold: Role A at Firma X, 14 days', TOPIC],
      ['line', 'Rejected: Role B', TOPIC],
      ['digest', expect.stringContaining('New matches') as string, TOPIC],
    ]);
  });

  it('keeps a line the webhook did not take and sends it, once, on the next flush', async () => {
    const user = newUser();
    statuses = [503];
    await make(1).sendLines(user, ['Gone cold: Role C']);
    expect(received.filter((m) => m.kind === 'line')).toEqual([]);
    statuses = [200];
    await make().afterRun(user, { since, ...NONE });
    await make().afterRun(user, { since, ...NONE });
    expect(received.filter((m) => m.kind === 'line').map((m) => m.text)).toEqual([
      'Gone cold: Role C',
    ]);
  });

  it('treats a webhook-level 4xx (workflow off, bad auth) as the webhook being down: the type opens and the pass stops', async () => {
    const user = newUser();
    statuses = [404];
    tags = [tag(1)];
    const result = await make().afterRun(user, { since, ...NONE });
    expect(result).toMatchObject({ digestSent: false, alertsSent: 0, unsent: 2 });
    // The digest was tried with retries, and the failure alert behind it was not tried.
    expect(received.filter((m) => m.kind === 'failed-request')).toHaveLength(3);

    statuses = [200];
    await make().afterRun(user, { since, ...NONE });
    expect(alerts().map((a) => a.text.toLowerCase())).toEqual([
      expect.stringContaining('failing'),
      expect.stringContaining('recovered'),
    ]);
    expect(digests()).toHaveLength(1);
  });

  it('setFailure opens a failure type once and closes it once, each with one alert', async () => {
    const user = newUser();
    statuses = [200];
    const n = make();
    await n.setFailure(user, 'gmail_token', true);
    await n.setFailure(user, 'gmail_token', true);
    await n.setFailure(user, 'gmail_token', false);
    await n.setFailure(user, 'gmail_token', false);
    expect(alerts().map((a) => a.text)).toEqual(['Failing: gmail_token', 'Recovered: gmail_token']);
  });
});
