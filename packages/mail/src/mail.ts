import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { AiError, isRunnerWide, type Ai } from '@job-portal/ai';
import type { Db, DbTx } from '@job-portal/db';
import type { Discovery } from '@job-portal/discovery';
import type { Review, ReviewSubject } from '@job-portal/review';
import type { Logger } from '@job-portal/shared';
import { TrackerError, type ApplicationStatus, type Tracker } from '@job-portal/tracker';
import { buildPrompt, parseClassification, type MailKind } from './classify';
import { GmailAuthError, GmailError, type GmailClient, type GmailMessage } from './gmail';
import {
  cleanBody,
  isJobLike,
  narrow,
  senderDomain,
  withinDomain,
  type MailText,
  type ReplyCandidate,
} from './text';
import { cursors, matches, processed, readFailures, unmatched, type Outcome } from './schema';

/** What Mail needs from Notifications; the module itself satisfies it. */
export interface Notify {
  sendLines: (userId: string, lines: string[]) => Promise<void>;
  setFailure: (userId: string, key: string, failing: boolean) => Promise<void>;
}

export interface MailDeps {
  tracker: Pick<Tracker, 'findJobIds' | 'setApplicationStatus' | 'addNote'>;
  discovery: Pick<Discovery, 'getJob'>;
  review: Pick<Review, 'create'>;
  /** Without a Gmail client or an AI the poll is skipped. */
  gmail?: GmailClient;
  ai?: Ai;
  notify?: Notify;
  /** Where the first poll starts; later polls resume from the stored cursor. Default: the first poll. */
  startDate?: Date;
  /** Most AI calls one poll makes; the rest of the mail waits for the next poll. */
  maxCallsPerPass: number;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface PollOutcome {
  status: 'skipped' | 'busy' | 'auth_error' | 'error' | 'done';
  /** Mails not seen before in this poll. */
  seen: number;
  applied: number;
  noted: number;
  review: number;
  unmatched: number;
  ignored: number;
  aiCalls: number;
}

export interface UnmatchedMail {
  id: string;
  messageId: string;
  from: string;
  subject: string;
  summary: string;
  receivedAt: Date;
}

export interface MatchDetail {
  messageId: string;
  kind: MailKind;
  summary: string;
  from: string;
  subject: string;
  /** The Job the AI picked. */
  suggestedJobId: string;
  /** The Jobs narrowing left; the user may pick any of them instead. */
  possibleJobIds: string[];
  receivedAt: Date;
}

/** A decision the mail_match item refuses, such as a Job that is not one of its possible Jobs. */
export class MailMatchError extends Error {
  override name = 'MailMatchError';
}

export interface Mail {
  /**
   * Reads the new mail of the inbox and applies it. Safe to call from several workers at once: a lease
   * on the cursor lets one poll run, and the processed-mail ledger stops a mail from applying twice.
   * Never throws for a Gmail, AI or token failure; the outcome says what happened.
   */
  poll: (userId: string) => Promise<PollOutcome>;
  /** Job-like mails that matched no Job, ordered and paged by id. */
  listUnmatched: (
    userId: string,
    page: { limit?: number; cursor?: string },
  ) => Promise<{ items: UnmatchedMail[]; nextCursor: string | null }>;
  /** The mail behind a mail_match Review item; null when there is none. */
  getMatch: (userId: string, messageId: string) => Promise<MatchDetail | null>;
  /**
   * The applier of mail_match items, run inside the Review decision's transaction. Confirm applies the mail to
   * `jobId` (one of the item's possible Jobs, else MailMatchError) or, without one, to the Job the AI picked;
   * disagree changes nothing. Returns the Telegram line to send after the commit, or null.
   */
  applyMatch: (
    tx: DbTx,
    userId: string,
    subject: ReviewSubject,
    decision: 'confirm' | 'disagree',
    jobId?: string,
  ) => Promise<string | null>;
}

const STATUS_FOR: Partial<Record<MailKind, ApplicationStatus>> = {
  rejection: 'rejected',
  screening: 'screening',
  interview: 'interview',
  offer: 'offer',
};
const LABEL: Partial<Record<ApplicationStatus, string>> = {
  rejected: 'Rejected',
  screening: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
};
/** Any application status but Accepted, Declined and Withdrawn can still get mail. */
const REPLY_STATUSES: ApplicationStatus[] = [
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'gone_cold',
];
const FEATURE = 'mail_classify';
const GMAIL_TOKEN = 'gmail_token';
/** Renewed before every mail, so it only runs out when one mail takes this long. */
const LEASE = sql`now() + interval '10 minutes'`;
const DEFAULT_LIMIT = 50;
/** Reads of one message that may fail before the mail is given up on. */
const MAX_READ_FAILURES = 3;
const hostOf = (url: string): string[] => {
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch {
    return [];
  }
};

const zero = (status: PollOutcome['status']): PollOutcome => ({
  status,
  seen: 0,
  applied: 0,
  noted: 0,
  review: 0,
  unmatched: 0,
  ignored: 0,
  aiCalls: 0,
});

export function createMail(db: Db, deps: MailDeps): Mail {
  const { tracker, discovery, review, gmail, ai, notify, log } = deps;

  /** Claims the message id in the ledger inside the caller's transaction; false when it was handled before. */
  async function claim(
    tx: DbTx,
    userId: string,
    messageId: string,
    outcome: Outcome,
    jobId: string | null = null,
  ): Promise<boolean> {
    const rows = await tx
      .insert(processed)
      .values({ userId, messageId, outcome, jobId })
      .onConflictDoNothing()
      .returning({ messageId: processed.messageId });
    return rows.length > 0;
  }

  /** Applies a classified mail to a Job under the Job lock; a refused change becomes a note, never a lost mail. */
  async function applyToJob(
    tx: DbTx,
    userId: string,
    jobId: string,
    kind: MailKind,
    messageId: string,
    summary: string,
  ): Promise<{ outcome: 'applied'; to: ApplicationStatus } | { outcome: 'noted' }> {
    const to = STATUS_FOR[kind];
    if (to === undefined) {
      const what = kind === 'acknowledgement' ? 'application received' : kind;
      await tracker.addNote(userId, jobId, `Gmail: ${what}. ${summary}`, tx);
      return { outcome: 'noted' };
    }
    try {
      await tracker.setApplicationStatus(
        userId,
        jobId,
        { to, actor: 'gmail', evidence: `gmail:${messageId}`, timezone: 'UTC' },
        tx,
      );
      return { outcome: 'applied', to };
    } catch (err) {
      if (!(err instanceof TrackerError)) throw err;
      await tracker.addNote(
        userId,
        jobId,
        `Gmail ${kind} mail not applied (${err.message}): ${summary}`,
        tx,
      );
      return { outcome: 'noted' };
    }
  }

  async function lineFor(userId: string, jobId: string, to: ApplicationStatus): Promise<string> {
    const job = await discovery.getJob(userId, jobId);
    const what =
      job === null ? 'a Job' : job.company === null ? job.title : `${job.title} at ${job.company}`;
    return `${LABEL[to] ?? to}: ${what}`;
  }

  async function replyCandidates(userId: string): Promise<ReplyCandidate[]> {
    const ids = new Set<string>();
    for (const applicationStatus of REPLY_STATUSES) {
      for (const id of await tracker.findJobIds(userId, { applicationStatus })) ids.add(id);
    }
    const out: ReplyCandidate[] = [];
    for (const id of ids) {
      // Discovery hides a Job an AI merge folded into another.
      const job = await discovery.getJob(userId, id);
      if (job)
        out.push({
          id,
          title: job.title,
          company: job.company,
          hosts: job.postings.flatMap((p) => hostOf(p.url)),
        });
    }
    return out;
  }

  /** The inbox lease: one poll per user at a time. Returns the cursor and the lease token, or null when another worker holds it. */
  async function acquire(userId: string): Promise<{ since: Date; token: string } | null> {
    await db
      .insert(cursors)
      .values({ userId, since: deps.startDate ?? new Date() })
      .onConflictDoNothing();
    const token = randomUUID();
    const [row] = await db
      .update(cursors)
      .set({ leasedUntil: LEASE, leaseToken: token })
      .where(
        and(
          eq(cursors.userId, userId),
          or(isNull(cursors.leasedUntil), lt(cursors.leasedUntil, sql`now()`)),
        ),
      )
      .returning({ since: cursors.since });
    return row ? { since: row.since, token } : null;
  }

  /** Extends the lease of this poll; false when another worker took it over after it ran out. */
  async function renew(userId: string, token: string): Promise<boolean> {
    const rows = await db
      .update(cursors)
      .set({ leasedUntil: LEASE })
      .where(and(eq(cursors.userId, userId), eq(cursors.leaseToken, token)))
      .returning({ userId: cursors.userId });
    return rows.length > 0;
  }

  async function pass(
    userId: string,
    { since, token }: { since: Date; token: string },
    client: GmailClient,
    runner: Ai,
  ): Promise<PollOutcome> {
    const out = zero('done');
    const lines: string[] = [];
    const [clock] = await db.execute<{ t: Date }>(sql`select now() as t`);
    const startedAt = new Date(clock?.t ?? Date.now());
    let pool: ReplyCandidate[] | null = null;
    // Set from inside handle(); an object so the control flow keeps seeing it can change.
    const run = { complete: true };

    /** Stores a mail that needs no Job change; false when it was handled before. */
    const keep = (
      m: GmailMessage,
      text: MailText,
      outcome: 'unmatched' | 'ignored',
      summary: string,
    ): Promise<boolean> =>
      db.transaction(async (tx) => {
        if (!(await claim(tx, userId, m.id, outcome))) return false;
        if (outcome === 'unmatched') {
          await tx.insert(unmatched).values({
            userId,
            messageId: m.id,
            fromAddress: text.from,
            subject: text.subject,
            summary,
            receivedAt: m.receivedAt,
          });
        }
        return true;
      });

    async function handle(m: GmailMessage): Promise<void> {
      const text: MailText = { from: m.from, subject: m.subject, body: cleanBody(m.text) };
      pool ??= await replyCandidates(userId);
      const narrowed = narrow(text, pool);
      if (narrowed.length === 0) {
        if (isJobLike(text)) out.unmatched += Number(await keep(m, text, 'unmatched', ''));
        else out.ignored += Number(await keep(m, text, 'ignored', ''));
        return;
      }
      if (out.aiCalls >= deps.maxCallsPerPass) {
        run.complete = false;
        return;
      }
      out.aiCalls += 1;
      const ids = narrowed.map((c) => c.id);
      let answer;
      try {
        answer = await runner.run(userId, FEATURE, buildPrompt(text, narrowed), (t) =>
          parseClassification(t, ids),
        );
      } catch (err) {
        // A bad answer or a rejected request belongs to this mail: keep it for the user to see.
        if (err instanceof AiError && !isRunnerWide(err.errorClass)) {
          out.unmatched += Number(await keep(m, text, 'unmatched', ''));
          return;
        }
        throw err;
      }
      const { kind, jobId, confidence, summary } = answer.value;
      // The code decides what is clear, never the model: exactly one Job left after narrowing, whose own
      // posting domain the sender's address belongs to, from mail whose DKIM signature Gmail verified for that
      // address's domain, and picked with high confidence. Anyone can write a company name or claim "high" in a
      // mail; everything else with a picked Job is the user's decision.
      const [only] = narrowed;
      const from = senderDomain(m.from);
      const trusted =
        narrowed.length === 1 &&
        only?.strong === true &&
        from !== null &&
        m.dkimDomain !== null &&
        withinDomain(from, m.dkimDomain);
      if (kind === 'other') {
        out.ignored += Number(await keep(m, text, 'ignored', summary));
      } else if (jobId === null) {
        out.unmatched += Number(await keep(m, text, 'unmatched', summary));
      } else if (confidence === 'high' && trusted && only.id === jobId) {
        const result = await db.transaction(async (tx) => {
          if (!(await claim(tx, userId, m.id, 'applied', jobId))) return null;
          const r = await applyToJob(tx, userId, jobId, kind, m.id, summary);
          if (r.outcome === 'noted') {
            await tx
              .update(processed)
              .set({ outcome: 'noted' })
              .where(and(eq(processed.userId, userId), eq(processed.messageId, m.id)));
          }
          return r;
        });
        if (result === null) return;
        if (result.outcome === 'applied') {
          out.applied += 1;
          lines.push(await lineFor(userId, jobId, result.to));
        } else out.noted += 1;
      } else {
        const created = await db.transaction(async (tx) => {
          if (!(await claim(tx, userId, m.id, 'review', jobId))) return false;
          await tx.insert(matches).values({
            userId,
            messageId: m.id,
            kind,
            suggestedJobId: jobId,
            possibleJobIds: ids,
            summary,
            fromAddress: text.from,
            subject: text.subject,
            receivedAt: m.receivedAt,
          });
          await review.create(
            userId,
            { kind: 'mail_match', subject: { messageId: m.id }, model: answer.model },
            tx,
          );
          return true;
        });
        out.review += Number(created);
      }
    }

    // A failing page or mail is logged and skipped, never fatal: the poll goes on with the rest and the cursor
    // stays put, so the next poll retries what failed. Only a refused token stops it.
    const failed = (what: string, err: unknown): void => {
      if (err instanceof GmailAuthError) throw err;
      log.warn({ err }, `Gmail ${what} failed; the poll goes on and retries it next time`);
      run.complete = false;
    };
    /** Counts a failed read; after MAX_READ_FAILURES the mail gets a 'failed' ledger row so it stops holding the cursor. */
    async function giveUpOnBadMail(userId: string, messageId: string): Promise<boolean> {
      const [row] = await db
        .insert(readFailures)
        .values({ userId, messageId, failures: 1 })
        .onConflictDoUpdate({
          target: [readFailures.userId, readFailures.messageId],
          set: { failures: sql`${readFailures.failures} + 1` },
        })
        .returning({ failures: readFailures.failures });
      if ((row?.failures ?? 0) < MAX_READ_FAILURES) return false;
      log.warn(
        { messageId },
        'Gmail never served this mail: given up, it is kept in the ledger as failed',
      );
      await db.transaction(async (tx) => {
        if (!(await claim(tx, userId, messageId, 'failed'))) return;
        // The user sees it among the unmatched mails instead of losing it silently.
        await tx
          .insert(unmatched)
          .values({
            userId,
            messageId,
            fromAddress: '(unreadable mail)',
            subject: messageId,
            summary: 'Gmail never served this mail; open it in Gmail.',
            receivedAt: new Date(),
          })
          .onConflictDoNothing();
      });
      return true;
    }

    try {
      // List every id of the window first (ids are cheap): when the page cap cuts a list, the next list starts
      // below the oldest id seen, known ones included, so a backlog is walked to its end whatever the ledger holds.
      const listed = new Set<string>();
      let before: Date | undefined;
      for (let first = true; ; first = false) {
        let page: { ids: string[]; truncated: boolean };
        try {
          page = await client.listIds(since, before);
        } catch (err) {
          if (first) throw err;
          failed('list', err);
          break;
        }
        // The token works: close the failure type if it was open.
        if (first) {
          await notify?.setFailure(userId, GMAIL_TOKEN, false).catch((err: unknown) => {
            log.warn({ err }, 'could not close the gmail_token failure');
          });
        }
        for (const id of page.ids) listed.add(id);
        if (!page.truncated) break;
        // The oldest id that can be read gives the next bound; one Gmail never serves is passed over for the
        // next older-looking one, so a poison mail cannot stop the walk.
        let next: Date | null = null;
        for (const id of [...page.ids].reverse()) {
          try {
            next = new Date((await client.get(id)).receivedAt.getTime() + 1000);
            break;
          } catch (err) {
            if (err instanceof GmailAuthError) throw err;
            log.warn({ err }, 'Gmail read failed while walking the window; trying the next id');
          }
        }
        if (next === null || (before !== undefined && next >= before)) {
          // ponytail: more than a list of mails in one second cannot be walked further; retried next poll.
          log.warn('the Gmail window cannot be walked further: set GMAIL_START_DATE later');
          run.complete = false;
          break;
        }
        before = next;
      }
      const ids = [...listed];
      const known = ids.length
        ? await db
            .select({ id: processed.messageId })
            .from(processed)
            .where(and(eq(processed.userId, userId), inArray(processed.messageId, ids)))
        : [];
      const handled = new Set(known.map((r) => r.id));
      // Gmail lists newest first; the oldest mail goes first, so a Screening reply is applied before the
      // Interview that followed it.
      const fresh = ids.filter((id) => !handled.has(id)).reverse();
      out.seen += fresh.length;
      for (const id of fresh) {
        if (!(await renew(userId, token))) {
          log.warn('mail poll lost its lease to another worker and stops');
          run.complete = false;
          break;
        }
        let m: GmailMessage;
        try {
          m = await client.get(id);
        } catch (err) {
          if (err instanceof GmailAuthError) throw err;
          log.warn({ err }, 'Gmail read failed; the poll goes on and retries it next time');
          // Only an error that asking again cannot fix counts; an outage or quota never gives a mail up.
          const permanent = err instanceof GmailError && err.permanent;
          if (!permanent || !(await giveUpOnBadMail(userId, id))) run.complete = false;
          continue;
        }
        await handle(m);
        if (!run.complete) break;
      }
      if (run.complete) {
        // Held an hour behind so a mail that reached the inbox late is still listed; the ledger skips the rest.
        await db
          .update(cursors)
          .set({
            since: sql`greatest(${cursors.since}, ${startedAt.toISOString()}::timestamptz - interval '1 hour')`,
          })
          .where(and(eq(cursors.userId, userId), eq(cursors.leaseToken, token)));
      }
    } catch (err) {
      if (err instanceof GmailAuthError) {
        out.status = 'auth_error';
        log.error('Gmail refused the token: sign in again');
        await notify?.setFailure(userId, GMAIL_TOKEN, true).catch((e: unknown) => {
          log.warn({ err: e }, 'could not open the gmail_token failure');
        });
      } else if (err instanceof GmailError) {
        out.status = 'error';
        log.warn({ reason: err.message }, 'Gmail poll failed, retrying next time');
      } else if (err instanceof AiError) {
        // The runner itself is down or refusing: every further call would fail too.
        out.status = 'error';
        log.error({ errorClass: err.errorClass }, 'mail classification stopped: AI runner failing');
      } else throw err;
    }
    if (lines.length > 0) {
      await notify?.sendLines(userId, lines).catch((err: unknown) => {
        log.warn({ err }, 'could not send Gmail status lines');
      });
    }
    return out;
  }

  return {
    async poll(userId) {
      if (!gmail || !ai) {
        log.info('mail poll skipped: Gmail or the AI runner is not configured');
        return zero('skipped');
      }
      const lease = await acquire(userId);
      if (!lease) return zero('busy');
      try {
        return await pass(userId, lease, gmail, ai);
      } finally {
        // Only this poll's own lease: one that ran out and was taken over belongs to another worker now.
        await db
          .update(cursors)
          .set({ leasedUntil: null, leaseToken: null })
          .where(and(eq(cursors.userId, userId), eq(cursors.leaseToken, lease.token)));
      }
    },

    async listUnmatched(userId, { limit = DEFAULT_LIMIT, cursor }) {
      const rows = await db
        .select()
        .from(unmatched)
        .where(
          and(
            eq(unmatched.userId, userId),
            cursor === undefined ? undefined : gt(unmatched.id, cursor),
          ),
        )
        .orderBy(asc(unmatched.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          messageId: r.messageId,
          from: r.fromAddress,
          subject: r.subject,
          summary: r.summary,
          receivedAt: r.receivedAt,
        })),
        nextCursor: rows.length > limit && last ? last.id : null,
      };
    },

    async getMatch(userId, messageId) {
      const [row] = await db
        .select()
        .from(matches)
        .where(and(eq(matches.userId, userId), eq(matches.messageId, messageId)));
      return row
        ? {
            messageId,
            kind: row.kind,
            summary: row.summary,
            from: row.fromAddress,
            subject: row.subject,
            suggestedJobId: row.suggestedJobId,
            possibleJobIds: row.possibleJobIds,
            receivedAt: row.receivedAt,
          }
        : null;
    },

    async applyMatch(tx, userId, subject, decision, jobId) {
      const messageId = subject.messageId ?? '';
      const [row] = await tx
        .select()
        .from(matches)
        .where(and(eq(matches.userId, userId), eq(matches.messageId, messageId)))
        .for('update');
      if (!row) throw new Error('mail_match item without its mail');
      const settle = (outcome: Outcome, job: string | null): Promise<unknown> =>
        tx
          .update(processed)
          .set({ outcome, jobId: job })
          .where(and(eq(processed.userId, userId), eq(processed.messageId, messageId)));
      if (decision === 'disagree') {
        await settle('disagreed', null);
        return null;
      }
      const target = jobId ?? row.suggestedJobId;
      if (!row.possibleJobIds.includes(target)) {
        throw new MailMatchError('that Job is not one of the Jobs this mail could belong to');
      }
      const r = await applyToJob(tx, userId, target, row.kind, row.messageId, row.summary);
      await settle(r.outcome, target);
      return r.outcome === 'applied' ? lineFor(userId, target, r.to) : null;
    },
  };
}
