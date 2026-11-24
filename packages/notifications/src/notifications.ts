import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Logger } from '@job-portal/shared';
import { digestPairs, messages, openFailures, type MessageKind } from './schema';

/** A Job and Target pair that gained a tag; Matching's `listNewTags` returns this shape. */
export interface NewTagInput {
  jobId: string;
  targetId: string;
  targetName: string;
  score: number | null;
  reasons: string[];
  /** The user disagreed with an AI fit rejection, so the pair is tagged whatever its score. */
  override: boolean;
}

/** What a digest line shows about a Job. */
export interface JobInfo {
  title: string;
  company: string | null;
  links: string[];
  /** false for a Dismissed or Expired Job: it is left out of the digest. */
  active: boolean;
}

export interface NotificationsDeps {
  /** The pairs tagged now that are new since the instant (Matching). */
  newTags: (userId: string, since: Date) => Promise<NewTagInput[]>;
  /** Title, company and posting links of a Job (Discovery); null when it is gone. */
  jobInfo: (userId: string, jobId: string) => Promise<JobInfo | null>;
  /** Review items waiting for a decision (Review). */
  pendingReviews: (userId: string) => Promise<number>;
  /** The n8n webhook and the Telegram topic id, both from env. */
  webhook: { url: string; topicId: string };
  /** Sends per message before it is left unsent. Default 3. */
  maxAttempts?: number;
  /** Wait before the second send; it doubles for each further one. Default 1000. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  log?: Pick<Logger, 'warn'>;
}

/** What a finished run tells Notifications. */
export interface RunReport {
  /** The run's start: a pair scored before it is not new. */
  since: Date;
  /** Failure types failing now, such as `source:greenhouse` or `board:greenhouse:acme`. */
  failing: string[];
  /**
   * What this run could observe. An entry is a whole type, or a prefix ending in a colon covering many
   * (`board:greenhouse:`). An open failure that is checked here and not failing has recovered; one this
   * run did not check stays open.
   */
  checked: string[];
}

export interface AfterRunResult {
  digestSent: boolean;
  alertsSent: number;
  /** Messages still waiting for the webhook, the user's whole outbox. */
  unsent: number;
}

export interface Notifications {
  /**
   * Call after a source run. Opens and closes failure types (one alert each time), stores a digest of
   * the pairs not yet listed, folds earlier unsent digests into it, then sends everything pending in
   * order. Never throws for a webhook failure: the messages stay stored. Safe to call from several
   * workers at once.
   */
  afterRun: (userId: string, report: RunReport) => Promise<AfterRunResult>;
}

interface DigestEntry {
  jobId: string;
  title: string;
  company: string | null;
  links: string[];
  targetId: string;
  targetName: string;
  score: number | null;
  reasons: string[];
  override: boolean;
}

interface DigestPayload {
  entries: DigestEntry[];
  pendingReviews: number;
  text: string;
}

const WEBHOOK_KEY = 'webhook';
const REQUEST_TIMEOUT_MS = 10_000;
/** Telegram caps a message at 4096 characters; lines stay short so a normal run fits. */
const MAX_REASONS = 3;
const MAX_LINKS = 2;

const humanize = (key: string): string => key.split(':').filter(Boolean).join(' ');

const covers = (checked: string[], key: string): boolean =>
  checked.some((c) => c === key || (c.endsWith(':') && key.startsWith(c)));

export function renderDigest(entries: DigestEntry[], pendingReviews: number): string {
  const jobs = new Map<string, DigestEntry[]>();
  for (const e of [...entries].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)))
    jobs.set(e.jobId, [...(jobs.get(e.jobId) ?? []), e]);
  const blocks = [...jobs.values()].map((rows) => {
    const [first] = rows;
    const head =
      first === undefined
        ? ''
        : first.company === null
          ? first.title
          : `${first.title} at ${first.company}`;
    const lines = rows.map((r) => {
      const score = r.score === null ? '' : `: ${String(r.score)}`;
      const reasons =
        r.reasons.length === 0 ? '' : ` - ${r.reasons.slice(0, MAX_REASONS).join('; ')}`;
      return `  ${r.targetName}${score}${r.override ? ' (override)' : ''}${reasons}`;
    });
    const links = (first?.links ?? []).slice(0, MAX_LINKS).map((l) => `  ${l}`);
    return [head, ...lines, ...links].join('\n');
  });
  return [
    `New matches (${String(jobs.size)})`,
    ...blocks,
    `Review waiting: ${String(pendingReviews)}`,
  ].join('\n\n');
}

/**
 * ponytail: one message per digest, no splitting for Telegram's length cap; reasons and links are trimmed
 * instead. Split into several messages if a run ever tags more than a few dozen Jobs.
 */
export function createNotifications(
  db: Db,
  {
    newTags,
    jobInfo,
    pendingReviews,
    webhook,
    maxAttempts = 3,
    backoffMs = 1000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: fetchImpl = fetch,
    log,
  }: NotificationsDeps,
): Notifications {
  const post = async (kind: MessageKind, payload: object): Promise<void> => {
    const res = await fetchImpl(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: webhook.topicId, kind, ...payload }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`webhook answered ${String(res.status)}`);
  };

  /** Sends with growing backoff; returns how many sends it made and whether the last one landed. */
  const sendWithRetries = async (
    kind: MessageKind,
    payload: object,
  ): Promise<{ ok: boolean; tries: number }> => {
    for (let tries = 1; ; tries += 1) {
      try {
        await post(kind, payload);
        return { ok: true, tries };
      } catch (err) {
        // The URL is a secret: log the reason only, never the address.
        log?.warn(
          { attempt: tries, reason: err instanceof Error ? err.message : 'unknown' },
          'webhook send failed',
        );
        if (tries >= maxAttempts) return { ok: false, tries };
        await sleep(backoffMs * 2 ** (tries - 1));
      }
    }
  };

  const queueAlert = (tx: Pick<Db, 'insert'>, userId: string, text: string) =>
    tx.insert(messages).values({ userId, kind: 'alert', payload: { text } });

  /** Opens the failing types and closes the recovered ones; the row insert or delete makes each alert fire once. */
  const syncFailures = async (userId: string, { failing, checked }: RunReport): Promise<void> => {
    for (const key of new Set(failing)) {
      await db.transaction(async (tx) => {
        const opened = await tx
          .insert(openFailures)
          .values({ userId, key })
          .onConflictDoNothing()
          .returning({ id: openFailures.id });
        if (opened.length > 0) await queueAlert(tx, userId, `Failing: ${humanize(key)}`);
      });
    }
    const open = await db
      .select({ key: openFailures.key })
      .from(openFailures)
      .where(eq(openFailures.userId, userId));
    for (const { key } of open) {
      if (key === WEBHOOK_KEY || failing.includes(key) || !covers(checked, key)) continue;
      await db.transaction(async (tx) => {
        const closed = await tx
          .delete(openFailures)
          .where(and(eq(openFailures.userId, userId), eq(openFailures.key, key)))
          .returning({ id: openFailures.id });
        if (closed.length > 0) await queueAlert(tx, userId, `Recovered: ${humanize(key)}`);
      });
    }
  };

  /** Stores a digest of the pairs no digest has listed yet, with the unsent digests folded in. */
  const storeDigest = async (userId: string, since: Date): Promise<void> => {
    const found = await newTags(userId, since);
    if (found.length === 0) return;
    const jobIds = [...new Set(found.map((t) => t.jobId))];
    const claimed = await db
      .select({ jobId: digestPairs.jobId, targetId: digestPairs.targetId })
      .from(digestPairs)
      .where(and(eq(digestPairs.userId, userId), inArray(digestPairs.jobId, jobIds)));
    const seen = new Set(claimed.map((c) => `${c.jobId}/${c.targetId}`));
    const fresh = found.filter((t) => !seen.has(`${t.jobId}/${t.targetId}`));
    const infos = new Map<string, JobInfo>();
    for (const id of new Set(fresh.map((t) => t.jobId))) {
      const info = await jobInfo(userId, id);
      if (info?.active === true) infos.set(id, info);
    }
    const candidates = fresh.filter((t) => infos.has(t.jobId));
    if (candidates.length === 0) return;
    const waiting = await pendingReviews(userId);

    await db.transaction(async (tx) => {
      // The unique key decides which worker lists a pair: only the one that inserts it.
      const won = await tx
        .insert(digestPairs)
        .values(candidates.map((t) => ({ userId, jobId: t.jobId, targetId: t.targetId })))
        .onConflictDoNothing()
        .returning({ jobId: digestPairs.jobId, targetId: digestPairs.targetId });
      if (won.length === 0) return;
      const mine = new Set(won.map((w) => `${w.jobId}/${w.targetId}`));
      const entries: DigestEntry[] = [];
      for (const t of candidates) {
        const info = infos.get(t.jobId);
        if (info === undefined || !mine.has(`${t.jobId}/${t.targetId}`)) continue;
        entries.push({
          jobId: t.jobId,
          title: info.title,
          company: info.company,
          links: info.links,
          targetId: t.targetId,
          targetName: t.targetName,
          score: t.score,
          reasons: t.reasons,
          override: t.override,
        });
      }
      // Row locks: a second worker folding the same digests waits, then finds them folded.
      const earlier = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.kind, 'digest'),
            eq(messages.status, 'pending'),
          ),
        )
        .orderBy(asc(messages.createdAt))
        .for('update');
      const all = [...earlier.flatMap((m) => (m.payload as DigestPayload).entries), ...entries];
      if (earlier.length > 0)
        await tx
          .update(messages)
          .set({ status: 'folded' })
          .where(
            inArray(
              messages.id,
              earlier.map((m) => m.id),
            ),
          );
      const payload: DigestPayload = {
        entries: all,
        pendingReviews: waiting,
        text: renderDigest(all, waiting),
      };
      await tx.insert(messages).values({ userId, kind: 'digest', payload });
    });
  };

  /** Sends the pending messages oldest first; stops at the first one the webhook refuses. */
  const flush = async (userId: string): Promise<{ digestSent: boolean; alertsSent: number }> => {
    const sent = { digestSent: false, alertsSent: 0 };
    for (let restart = true; restart;) {
      restart = false;
      const ids = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.status, 'pending')))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      for (const { id } of ids) {
        // The row lock stays through the send, so two workers never send one message twice.
        const outcome = await db.transaction(async (tx) => {
          const [m] = await tx
            .select()
            .from(messages)
            .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
            .for('update', { skipLocked: true });
          if (m === undefined) return 'skipped' as const;
          const { ok, tries } = await sendWithRetries(m.kind, m.payload as object);
          await tx
            .update(messages)
            .set(
              ok
                ? { status: 'sent', attempts: m.attempts + tries, sentAt: sql`now()` }
                : { attempts: m.attempts + tries },
            )
            .where(eq(messages.id, id));
          if (ok) {
            if (m.kind === 'digest') sent.digestSent = true;
            else sent.alertsSent += 1;
          }
          return ok ? ('sent' as const) : ('failed' as const);
        });
        if (outcome === 'failed') {
          await db.transaction(async (tx) => {
            const opened = await tx
              .insert(openFailures)
              .values({ userId, key: WEBHOOK_KEY })
              .onConflictDoNothing()
              .returning({ id: openFailures.id });
            if (opened.length > 0) await queueAlert(tx, userId, `Failing: ${WEBHOOK_KEY}`);
          });
          return sent;
        }
        if (outcome === 'sent') {
          const recovered = await db.transaction(async (tx) => {
            const closed = await tx
              .delete(openFailures)
              .where(and(eq(openFailures.userId, userId), eq(openFailures.key, WEBHOOK_KEY)))
              .returning({ id: openFailures.id });
            if (closed.length === 0) return false;
            await queueAlert(tx, userId, `Recovered: ${WEBHOOK_KEY}`);
            return true;
          });
          if (recovered) {
            restart = true;
            break;
          }
        }
      }
    }
    return sent;
  };

  return {
    async afterRun(userId, report) {
      await syncFailures(userId, report);
      await storeDigest(userId, report.since);
      const sent = await flush(userId);
      const [row] = await db
        .select({ n: count() })
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.status, 'pending')));
      return { ...sent, unsent: row?.n ?? 0 };
    },
  };
}
