import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AiError, aiMigrations, createAi, createAiLog, type AiRunner } from '@job-portal/ai';
import { createDb, runMigrationsWithLock, type DbHandle } from '@job-portal/db';
import { createDiscovery, discoveryMigrations, type Discovery } from '@job-portal/discovery';
import { createReview, reviewMigrations, type Review } from '@job-portal/review';
import { createLogger } from '@job-portal/shared';
import { createTracker, trackerMigrations, type Tracker } from '@job-portal/tracker';
import { createGmailClient } from './gmail';
import { createMail, type Mail, type Notify } from './mail';
import { mailMigrations } from './index';
import { createFakeGmail, type FakeGmail, type FakeMail } from './testing';

// A fresh pair of users per test, so message ids and Jobs of one test never meet another's.
let counter = 0;
let USER = '';
let OTHER = '';
beforeEach(() => {
  counter += 1;
  const tail = String(counter).padStart(4, '0');
  USER = `00000000-0000-4000-8000-0000000a${tail}`;
  OTHER = `00000000-0000-4000-8000-0000000b${tail}`;
});

describe('Mail against real Postgres, a fake Gmail API and a scripted AI runner', () => {
  let container: StartedPostgreSqlContainer;
  let handle: DbHandle;
  let discovery: Discovery;
  let tracker: Tracker;
  let review: Review;
  let n = 0;
  let fake: FakeGmail;
  let prompts: string[];
  /** The scripted AI: the first rule whose text the prompt contains answers. */
  let rules: { when: string; answer: object | Error | string }[];
  let lines: string[];
  let failures: [string, boolean][];

  const runner: AiRunner = {
    name: 'openrouter',
    model: 'vendor/model-a',
    complete: (prompt) => {
      prompts.push(prompt);
      const rule = rules.find((r) => prompt.includes(r.when));
      if (!rule) return Promise.reject(new AiError('request', 'no rule'));
      if (rule.answer instanceof Error) return Promise.reject(rule.answer);
      return Promise.resolve({
        text: typeof rule.answer === 'string' ? rule.answer : JSON.stringify(rule.answer),
        model: 'vendor/model-a',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      });
    },
  };
  const notify: Notify = {
    sendLines: (_u, l) => {
      lines.push(...l);
      return Promise.resolve();
    },
    setFailure: (_u, key, failing) => {
      failures.push([key, failing]);
      return Promise.resolve();
    },
  };

  const make = (over: { maxCallsPerPass?: number; gmail?: false } = {}): Mail =>
    createMail(handle.db, {
      tracker,
      discovery,
      review,
      ai: createAi(createAiLog(handle.db), runner),
      ...(over.gmail === false
        ? {}
        : {
            gmail: createGmailClient({
              clientId: 'client-id-placeholder',
              clientSecret: 'client-secret-placeholder',
              refreshToken: 'refresh-token-placeholder',
              fetch: fake.fetch,
            }),
          }),
      notify,
      startDate: new Date('2026-01-01T00:00:00Z'),
      maxCallsPerPass: over.maxCallsPerPass ?? 50,
      log: createLogger({ level: 'silent' }),
    });

  /** A Job of the user with an application status, at a company the mails name. */
  const applied = async (
    company: string,
    to: 'applied' | 'screening' | 'rejected' = 'applied',
    user = USER,
  ): Promise<string> => {
    n += 1;
    const { jobId } = await discovery.addJob(user, {
      title: `Role ${String(n)}`,
      company,
      url: `https://jobs.example.invalid/${String(n)}`,
    });
    await tracker.setApplicationStatus(user, jobId, {
      to: 'applied',
      actor: 'user',
      timezone: 'UTC',
    });
    if (to !== 'applied') {
      await tracker.setApplicationStatus(user, jobId, { to, actor: 'user', timezone: 'UTC' });
    }
    return jobId;
  };
  const mail = (id: string, company: string, over: Partial<FakeMail> = {}): FakeMail => ({
    id,
    from: `Recruiting <hr@${company.toLowerCase()}.example>`,
    subject: `Update ${id}`,
    body: `Dear applicant, news from ${company}. Marker ${id}`,
    receivedAt: new Date(),
    ...over,
  });
  const say = (id: string, answer: object): void => {
    rules.push({ when: `Marker ${id}`, answer });
  };
  const verdict = (kind: string, jobId: string | null, confidence = 'high') => ({
    kind,
    jobId,
    confidence,
    summary: `Summary of a ${kind} mail.`,
  });
  const status = async (jobId: string, user = USER): Promise<string | null> =>
    (await tracker.getStates(user, [jobId])).get(jobId)?.applicationStatus ?? null;
  const events = async (jobId: string, user = USER) =>
    (await tracker.getTimeline(user, jobId)).events.filter((e) => e.actor === 'gmail');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrationsWithLock(container.getConnectionUri(), [
      aiMigrations,
      discoveryMigrations,
      reviewMigrations,
      trackerMigrations,
      mailMigrations,
    ]);
    handle = createDb(container.getConnectionUri());
    discovery = createDiscovery(handle.db, []);
    tracker = createTracker(handle.db, discovery);
    review = createReview(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await container.stop();
  });
  const reset = (mails: FakeMail[]): void => {
    fake = createFakeGmail(mails);
    prompts = [];
    rules = [];
    lines = [];
    failures = [];
  };

  it.each([
    ['rejection', 'rejected', 'Rejected'],
    ['screening', 'screening', 'Screening'],
    ['interview', 'interview', 'Interview'],
    ['offer', 'offer', 'Offer'],
  ])(
    'a clear %s mail sets %s through the Timeline as actor gmail and posts one line',
    async (kind, to, label) => {
      const company = `Firma${kind}`;
      const job = await applied(company);
      reset([mail('m1', company)]);
      say('m1', verdict(kind, job));
      const out = await make().poll(USER);
      expect(out).toMatchObject({ status: 'done', applied: 1 });
      expect(await status(job)).toBe(to);
      expect(await events(job)).toEqual([
        expect.objectContaining({ from: 'applied', to, actor: 'gmail', evidence: 'gmail:m1' }),
      ]);
      expect(lines).toEqual([expect.stringContaining(`${label}: Role `)]);
      expect(lines[0]).toContain(`at ${company}`);
    },
  );

  it('an acknowledgement only adds a Timeline note and never sets Applied', async () => {
    const job = await applied('Firmaack');
    // A Job with no application is never a candidate, however well the mail names it.
    n += 1;
    const { jobId: fresh } = await discovery.addJob(USER, {
      title: 'Fresh',
      company: 'Firmafresh',
      url: `https://jobs.example.invalid/${String(n)}`,
    });
    reset([mail('m1', 'Firmaack'), mail('m2', 'Firmafresh', { subject: 'Your application' })]);
    say('m1', verdict('acknowledgement', job));
    const out = await make().poll(USER);
    expect(out).toMatchObject({ applied: 0, noted: 1 });
    expect(await status(job)).toBe('applied');
    expect(await events(job)).toEqual([]);
    expect((await tracker.getTimeline(USER, job)).notes.map((x) => x.text)).toEqual([
      expect.stringContaining('application received'),
    ]);
    expect(lines).toEqual([]);
    expect(await status(fresh)).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  it('an invalid transition (a final status) becomes a Timeline note and the mail is kept', async () => {
    const job = await applied('Firmafinal', 'rejected');
    reset([mail('m1', 'Firmafinal')]);
    say('m1', verdict('interview', job));
    const out = await make().poll(USER);
    expect(out).toMatchObject({ applied: 0, noted: 1 });
    expect(await status(job)).toBe('rejected');
    expect(await events(job)).toEqual([]);
    expect((await tracker.getTimeline(USER, job)).notes[0]?.text).toMatch(/interview.*final/i);
    expect(lines).toEqual([]);
  });

  it('a mail already handled changes nothing when it comes again', async () => {
    const job = await applied('Firmareplay');
    reset([mail('m1', 'Firmareplay')]);
    say('m1', verdict('screening', job));
    const gmail = make();
    await gmail.poll(USER);
    const again = await gmail.poll(USER);
    await make().poll(USER);
    expect(again).toMatchObject({ status: 'done', seen: 0, applied: 0 });
    expect(prompts).toHaveLength(1);
    expect(await events(job)).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('two workers polling at once apply a mail once: one runs, the other finds the inbox busy', async () => {
    const job = await applied('Firmabusy');
    reset([mail('m1', 'Firmabusy')]);
    say('m1', verdict('offer', job));
    const [a, b] = await Promise.all([make().poll(USER), make().poll(USER)]);
    expect([a.status, b.status].sort()).toEqual(['busy', 'done']);
    expect(await events(job)).toHaveLength(1);
  });

  it('an unclear match creates a mail_match item with the mail summary; confirming applies it once', async () => {
    const job = await applied('Firmaunclear');
    reset([mail('m1', 'Firmaunclear'), mail('m2', 'Firmaunclear')]);
    say('m1', verdict('offer', job, 'low'));
    say('m2', verdict('rejection', job, 'low'));
    const mailMod = make();
    const out = await mailMod.poll(USER);
    expect(out).toMatchObject({ review: 2, applied: 0 });
    expect(await status(job)).toBe('applied');
    const { items } = await review.list(USER, { kind: 'mail_match' });
    expect(items).toHaveLength(2);
    const first = items.find((i) => i.subject.messageId === 'm1');
    expect(await mailMod.getMatch(USER, 'm1')).toMatchObject({
      kind: 'offer',
      summary: 'Summary of a offer mail.',
      suggestedJobId: job,
      candidateJobIds: [job],
    });

    const done: (string | null)[] = [];
    await review.decide(USER, first?.id ?? '', 'confirm', async (item, tx, d) => {
      done.push(await mailMod.applyMatch(tx, USER, item.subject, d));
    });
    expect(await status(job)).toBe('offer');
    expect(done[0]).toMatch(/^Offer: Role \d+ at Firmaunclear/);

    const second = items.find((i) => i.subject.messageId === 'm2');
    await review.decide(USER, second?.id ?? '', 'disagree', async (item, tx, d) => {
      done.push(await mailMod.applyMatch(tx, USER, item.subject, d));
    });
    expect(done[1]).toBeNull();
    expect(await status(job)).toBe('offer');
    expect(await events(job)).toHaveLength(1);
  });

  it('a confirmed item whose transition became invalid leaves a note and no state change', async () => {
    const job = await applied('Firmalate');
    reset([mail('m1', 'Firmalate')]);
    say('m1', verdict('screening', job, 'low'));
    const mailMod = make();
    await mailMod.poll(USER);
    await tracker.setApplicationStatus(USER, job, {
      to: 'withdrawn',
      actor: 'user',
      timezone: 'UTC',
    });
    const { items } = await review.list(USER, { kind: 'mail_match' });
    const item = items.find((i) => i.subject.messageId === 'm1');
    let line: string | null = 'unset';
    await review.decide(USER, item?.id ?? '', 'confirm', async (i, tx, d) => {
      line = await mailMod.applyMatch(tx, USER, i.subject, d);
    });
    expect(line).toBeNull();
    expect(await status(job)).toBe('withdrawn');
    expect((await tracker.getTimeline(USER, job)).notes[0]?.text).toMatch(/screening.*final/i);
  });

  it('stores a job-like mail that matches nothing, lists it, and drops other mail with only a ledger row', async () => {
    await applied('Firmaother');
    reset([
      mail('u1', 'Nobodyco', { subject: 'Your application to Nobodyco' }),
      mail('u2', 'Nobodyco', {
        subject: 'Lunch on Friday?',
        body: 'Marker u2 noon at the usual place',
      }),
      mail('u3', 'Firmaother', { subject: 'Hello' }),
    ]);
    say('u3', verdict('rejection', null));
    const mailMod = make();
    const out = await mailMod.poll(USER);
    expect(out).toMatchObject({ unmatched: 2, ignored: 1 });
    const list = await mailMod.listUnmatched(USER, {});
    expect(list.items.map((i) => i.messageId).sort()).toEqual(['u1', 'u3']);
    expect(list.items.find((i) => i.messageId === 'u3')?.summary).toBe(
      'Summary of a rejection mail.',
    );
    expect((await mailMod.listUnmatched(USER, { limit: 1 })).nextCursor).not.toBeNull();
    // The next poll does not store them again.
    await mailMod.poll(USER);
    expect((await mailMod.listUnmatched(USER, {})).items).toHaveLength(2);
    expect(await mailMod.listUnmatched(OTHER, {})).toEqual({ items: [], nextCursor: null });
  });

  it('a Gmail token error opens the gmail_token failure, leaves the mail for later and closes it on the next good poll', async () => {
    const job = await applied('Firmatoken');
    reset([mail('m1', 'Firmatoken')]);
    say('m1', verdict('interview', job));
    const mailMod = make();
    fake.tokenMode = 'invalid_grant';
    expect(await mailMod.poll(USER)).toMatchObject({ status: 'auth_error' });
    expect(failures).toEqual([['gmail_token', true]]);
    expect(await status(job)).toBe('applied');
    fake.tokenMode = 'ok';
    expect(await mailMod.poll(USER)).toMatchObject({ status: 'done', applied: 1 });
    expect(failures).toEqual([
      ['gmail_token', true],
      ['gmail_token', false],
    ]);
  });

  it('an outage is not a token failure and the mail waits for the next poll', async () => {
    const job = await applied('Firmaoutage');
    reset([mail('m1', 'Firmaoutage')]);
    say('m1', verdict('screening', job));
    fake.tokenMode = 'unavailable';
    const mailMod = make();
    expect(await mailMod.poll(USER)).toMatchObject({ status: 'error' });
    expect(failures).toEqual([]);
    fake.tokenMode = 'ok';
    expect(await mailMod.poll(USER)).toMatchObject({ applied: 1 });
  });

  it('a runner-wide AI failure stops the pass and keeps the mail for the next poll; a bad answer stores it unmatched', async () => {
    const job = await applied('Firmaai');
    const job2 = await applied('Firmaai2');
    reset([mail('m1', 'Firmaai'), mail('m2', 'Firmaai2')]);
    rules.push({ when: 'Marker m1', answer: new AiError('auth', 'key refused') });
    say('m2', verdict('screening', job2));
    const mailMod = make();
    expect(await mailMod.poll(USER)).toMatchObject({ status: 'error', applied: 0 });
    expect(await status(job)).toBe('applied');
    rules = [];
    say('m1', verdict('screening', job));
    say('m2', verdict('screening', job2));
    expect(await mailMod.poll(USER)).toMatchObject({ status: 'done', applied: 2 });

    const job3 = await applied('Firmabad');
    fake.mails.push(mail('m3', 'Firmabad', { subject: 'Your application' }));
    rules = [{ when: 'Marker m3', answer: 'not json' }];
    expect(await mailMod.poll(USER)).toMatchObject({ unmatched: 1 });
    expect(await status(job3)).toBe('applied');
  });

  it('makes at most maxCallsPerPass AI calls and leaves the rest for the next poll', async () => {
    const a = await applied('Firmacapa');
    const b = await applied('Firmacapb');
    reset([mail('m1', 'Firmacapa'), mail('m2', 'Firmacapb')]);
    say('m1', verdict('screening', a));
    say('m2', verdict('screening', b));
    const mailMod = make({ maxCallsPerPass: 1 });
    expect(await mailMod.poll(USER)).toMatchObject({ applied: 1, aiCalls: 1 });
    expect(await mailMod.poll(USER)).toMatchObject({ applied: 1, aiCalls: 1 });
    expect(await status(a)).toBe('screening');
    expect(await status(b)).toBe('screening');
  });

  it('sends the AI only subject and cleaned body: no quoted reply, signature or attachment', async () => {
    const job = await applied('Firmaclean');
    reset([
      mail('m1', 'Firmaclean', {
        body: 'Marker m1 Visible line\n> quoted history line\nOn Mon, 3 Nov 2026, X <x@example.invalid> wrote:\nold text\n',
        attachment: 'attachment secret text',
      }),
    ]);
    say('m1', verdict('screening', job));
    await make().poll(USER);
    expect(prompts[0]).toContain('Visible line');
    for (const hidden of ['quoted history', 'old text', 'attachment secret']) {
      expect(prompts[0]).not.toContain(hidden);
    }
  });

  it('keeps users apart: a poll never touches the Job of another user, and the ledger is per user', async () => {
    const mine = await applied('Firmaiso');
    const theirs = await applied('Firmaiso', 'applied', OTHER);
    reset([mail('m1', 'Firmaiso')]);
    say('m1', verdict('rejection', mine));
    await make().poll(USER);
    expect(await status(mine)).toBe('rejected');
    expect(await status(theirs, OTHER)).toBe('applied');
    // The same message id is still new for the other user.
    rules = [];
    say('m1', verdict('rejection', theirs));
    await make().poll(OTHER);
    expect(await status(theirs, OTHER)).toBe('rejected');
    expect(await events(mine)).toHaveLength(1);
  });

  it('set_status racing a Gmail apply leaves one consistent result', async () => {
    for (let i = 0; i < 6; i += 1) {
      const job = await applied(`Firmarace${String(i)}`);
      reset([mail('m1', `Firmarace${String(i)}`)]);
      say('m1', verdict('rejection', job));
      const [, userMove] = await Promise.allSettled([
        make().poll(USER),
        tracker.setApplicationStatus(USER, job, {
          to: 'withdrawn',
          actor: 'user',
          timezone: 'UTC',
        }),
      ]);
      const final = await status(job);
      const gmailEvents = await events(job);
      const { events: all, notes } = await tracker.getTimeline(USER, job);
      const app = all.filter((e) => e.field === 'application');
      // Either order is fine, but the chain of changes must be unbroken and end in the stored status.
      expect(app.at(-1)?.to).toBe(final);
      for (const [k, e] of app.entries()) expect(e.from).toBe(k === 0 ? null : app[k - 1]?.to);
      if (final === 'rejected') {
        expect(gmailEvents).toHaveLength(1);
        expect(userMove.status).toBe('rejected');
      } else {
        expect(final).toBe('withdrawn');
        expect(gmailEvents).toHaveLength(0);
        // Withdrawn first: the Job is no longer a candidate, or Gmail's change was refused as a note.
        expect(notes.every((x) => /final/.test(x.text))).toBe(true);
      }
    }
  });

  it('skips the poll without a Gmail client, never throwing', async () => {
    reset([]);
    expect(await make({ gmail: false }).poll(USER)).toMatchObject({ status: 'skipped' });
  });
});
