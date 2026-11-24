import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import type { Logger } from '@job-portal/shared';
import { digestPairs, messages, openFailures, watermarks, type MessageKind } from './schema';

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
  /**
   * Stores each short line (a Gone cold or Gmail status change) as its own message of kind line, then sends
   * everything pending the same way afterRun does: same retries, same webhook-down rule. A line the webhook
   * did not take stays stored and goes out on a later flush.
   */
  sendLines: (userId: string, lines: string[]) => Promise<void>;
  /**
   * Opens (failing true) or closes (false) one failure type outside a Pipeline run, such as `gmail_token`.
   * Each change queues its alert once however many workers race; the alert is sent at once.
   */
  setFailure: (userId: string, key: string, failing: boolean) => Promise<void>;
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
const MESSAGE_REFUSALS = new Set([400, 413, 422]);
const REQUEST_TIMEOUT_MS = 10_000;
/** Telegram caps a message at 4096 characters; every digest message stays under this. */
const MAX_TEXT = 3900;
/** Room kept in each message for its header and the footer of the last one. */
const FRAME = 120;
const MAX_REASONS = 3;
const MAX_LINKS = 2;
/**
 * New tags are looked up from a watermark held this far behind now. A scoring transaction can stamp a
 * score earlier than the moment it commits; the overlap only costs a rescan, since a claimed pair is
 * never listed twice. Matches the Pipeline's one-hour bound on a run.
 */
const WATERMARK_LAG_MS = 60 * 60 * 1000;

const humanize = (key: string): string => key.split(':').filter(Boolean).join(' ');

const covers = (checked: string[], key: string): boolean =>
  checked.some((c) => c === key || (c.endsWith(':') && key.startsWith(c)));

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One Job's lines. A Job too long for a message loses its reasons first, its links last. */
function jobBlock(rows: DigestEntry[]): string {
  const [first] = rows;
  const title = clip(first?.title ?? '', 100);
  const head = first?.company == null ? title : `${title} at ${clip(first.company, 60)}`;
  const links = (first?.links ?? []).slice(0, MAX_LINKS).map((l) => `  ${clip(l, 200)}`);
  const build = (withReasons: boolean): string => {
    const lines = rows.map((r) => {
      const score = r.score === null ? '' : `: ${String(r.score)}`;
      const reasons = withReasons
        ? r.reasons
            .slice(0, MAX_REASONS)
            .map((x) => clip(x, 120))
            .join('; ')
        : '';
      return `  ${clip(r.targetName, 40)}${score}${r.override ? ' (override)' : ''}${reasons === '' ? '' : ` - ${reasons}`}`;
    });
    return [head, ...lines, ...links].join('\n');
  };
  const full = build(true);
  const block = full.length <= MAX_TEXT - FRAME ? full : build(false);
  return clip(block, MAX_TEXT - FRAME);
}

/**
 * The digest as one or more messages under Telegram's cap: whole Job blocks, best score first, packed into
 * messages in order. Each message carries the entries it lists; the Review count closes the last one.
 */
function renderDigest(
  entries: DigestEntry[],
  pendingReviews: number,
): { entries: DigestEntry[]; text: string }[] {
  const jobs = new Map<string, DigestEntry[]>();
  for (const e of [...entries].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)))
    jobs.set(e.jobId, [...(jobs.get(e.jobId) ?? []), e]);
  const groups: { rows: DigestEntry[]; blocks: string[]; size: number }[] = [];
  for (const rows of jobs.values()) {
    const block = jobBlock(rows);
    const open = groups.at(-1);
    if (open && open.size + block.length + 2 <= MAX_TEXT - FRAME) {
      open.rows.push(...rows);
      open.blocks.push(block);
      open.size += block.length + 2;
    } else groups.push({ rows: [...rows], blocks: [block], size: block.length + 2 });
  }
  const footer = `Review waiting: ${String(pendingReviews)}`;
  return groups.map((g, i) => ({
    entries: g.rows,
    text: [
      groups.length === 1
        ? `New matches (${String(jobs.size)})`
        : `New matches (${String(jobs.size)}), part ${String(i + 1)} of ${String(groups.length)}`,
      ...g.blocks,
      ...(i === groups.length - 1 ? [footer] : []),
    ].join('\n\n'),
  }));
}

/**
 * ponytail: a send holds one pool connection and the message row lock through its retries, up to about
 * 33 s at the defaults (3 x 10 s timeout plus backoff): fine for one or two workers, move the send out of
 * the transaction (a lease column) before running many.
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
  class Refused extends Error {}

  const post = async (kind: MessageKind, payload: object): Promise<void> => {
    const res = await fetchImpl(webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: webhook.topicId, kind, ...payload }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return;
    const reason = `webhook answered ${String(res.status)}`;
    // Only these are about this message (bad body, too large, unprocessable): retrying cannot help. Any
    // other 4xx (404 workflow off, 401 or 403 auth) is the webhook itself being unusable, so it counts as down.
    if (MESSAGE_REFUSALS.has(res.status)) throw new Refused(reason);
    throw new Error(reason);
  };

  /**
   * Sends with growing backoff. `refused` means the webhook rejected this message itself, so the next
   * message may still go; otherwise the webhook is down and the pass stops.
   */
  const sendWithRetries = async (
    kind: MessageKind,
    payload: object,
  ): Promise<{ ok: boolean; tries: number; refused: boolean }> => {
    for (let tries = 1; ; tries += 1) {
      try {
        await post(kind, payload);
        return { ok: true, tries, refused: false };
      } catch (err) {
        // The URL is a secret: log the reason only, never the address.
        log?.warn(
          { attempt: tries, reason: err instanceof Error ? err.message : 'unknown' },
          'webhook send failed',
        );
        const refused = err instanceof Refused;
        if (refused || tries >= maxAttempts) return { ok: false, tries, refused };
        await sleep(backoffMs * 2 ** (tries - 1));
      }
    }
  };

  const queueAlert = (tx: Pick<Db, 'insert'>, userId: string, text: string) =>
    tx.insert(messages).values({ userId, kind: 'alert', payload: { text } });

  /** The row insert makes the "Failing" alert fire once, however many workers race. True when this call opened it. */
  const openFailure = (userId: string, key: string): Promise<boolean> =>
    db.transaction(async (tx) => {
      const opened = await tx
        .insert(openFailures)
        .values({ userId, key })
        .onConflictDoNothing()
        .returning({ id: openFailures.id });
      if (opened.length === 0) return false;
      await queueAlert(tx, userId, `Failing: ${humanize(key)}`);
      return true;
    });

  /** The row delete makes the "Recovered" alert fire once. True when this call closed it. */
  const closeFailure = (userId: string, key: string): Promise<boolean> =>
    db.transaction(async (tx) => {
      const closed = await tx
        .delete(openFailures)
        .where(and(eq(openFailures.userId, userId), eq(openFailures.key, key)))
        .returning({ id: openFailures.id });
      if (closed.length === 0) return false;
      await queueAlert(tx, userId, `Recovered: ${humanize(key)}`);
      return true;
    });

  /** Opens the failing types and closes the recovered ones. */
  const syncFailures = async (userId: string, { failing, checked }: RunReport): Promise<void> => {
    for (const key of new Set(failing)) await openFailure(userId, key);
    const open = await db
      .select({ key: openFailures.key })
      .from(openFailures)
      .where(eq(openFailures.userId, userId));
    for (const { key } of open)
      if (key !== WEBHOOK_KEY && !failing.includes(key) && covers(checked, key))
        await closeFailure(userId, key);
  };

  /**
   * Stores a digest of the pairs no digest has listed yet, with the unsent digest messages folded in and
   * everything re-split. The watermark moves only once the digest is stored, so a crash before that lists
   * the same pairs on the next run instead of losing them.
   */
  const storeDigest = async (userId: string, since: Date): Promise<void> => {
    const [clock] = await db.execute<{ t: Date }>(sql`select now() as t`);
    const asOf = new Date(new Date(clock?.t ?? Date.now()).getTime() - WATERMARK_LAG_MS);
    await db.insert(watermarks).values({ userId, through: since }).onConflictDoNothing();
    const [mark] = await db
      .select({ through: watermarks.through })
      .from(watermarks)
      .where(eq(watermarks.userId, userId));
    await listNew(userId, mark?.through ?? since);
    await db
      .update(watermarks)
      .set({ through: sql`greatest(${watermarks.through}, ${asOf.toISOString()}::timestamptz)` })
      .where(eq(watermarks.userId, userId));
  };

  const listNew = async (userId: string, from: Date): Promise<void> => {
    const found = await newTags(userId, from);
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
    // A Job that is Dismissed or Expired when its pair is looked at is skipped for good, unless the user
    // later overrides its tag.
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
      // Row locks: a second worker folding the same messages waits, then finds them folded.
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
      // One outbox row per message: its pairs count as sent only when that row got a 2xx.
      // Distinct created times keep the parts in order (one transaction shares one now()).
      const parts = renderDigest(all, waiting);
      const base = Date.now();
      await tx.insert(messages).values(
        parts.map((p, i) => ({
          createdAt: new Date(base + i),
          userId,
          kind: 'digest' as const,
          payload: {
            entries: p.entries,
            pendingReviews: waiting,
            text: p.text,
          } satisfies DigestPayload,
        })),
      );
    });
  };

  /**
   * Sends the pending messages, alerts first (a digest never holds one back), each kind oldest first. A
   * message the webhook rejects (4xx) stays pending and the pass goes on; a webhook that is down stops it.
   */
  const flush = async (userId: string): Promise<{ digestSent: boolean; alertsSent: number }> => {
    const sent = { digestSent: false, alertsSent: 0 };
    const skip = new Set<string>();
    for (let restart = true; restart;) {
      restart = false;
      const ids = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.status, 'pending')))
        .orderBy(sql`${messages.kind} = 'digest'`, asc(messages.createdAt), asc(messages.id));
      for (const { id } of ids) {
        if (skip.has(id)) continue;
        // The row lock stays through the send, so two workers never send one message twice.
        const outcome = await db.transaction(async (tx) => {
          const [m] = await tx
            .select()
            .from(messages)
            .where(and(eq(messages.id, id), eq(messages.status, 'pending')))
            .for('update', { skipLocked: true });
          if (m === undefined) return 'skipped' as const;
          const { ok, tries, refused } = await sendWithRetries(m.kind, m.payload as object);
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
          return ok ? ('sent' as const) : refused ? ('refused' as const) : ('down' as const);
        });
        if (outcome === 'down') {
          await openFailure(userId, WEBHOOK_KEY);
          return sent;
        }
        if (outcome === 'refused') skip.add(id);
        if (outcome === 'sent' && (await closeFailure(userId, WEBHOOK_KEY))) {
          restart = true;
          break;
        }
      }
    }
    return sent;
  };

  return {
    async setFailure(userId, key, failing) {
      const changed = failing ? await openFailure(userId, key) : await closeFailure(userId, key);
      if (changed) await flush(userId);
    },

    async sendLines(userId, lines) {
      if (lines.length === 0) return;
      // Distinct created times keep the lines in the order given (one statement shares one now()).
      const base = Date.now();
      await db.insert(messages).values(
        lines.map((text, i) => ({
          createdAt: new Date(base + i),
          userId,
          kind: 'line' as const,
          payload: { text: clip(text, MAX_TEXT) },
        })),
      );
      await flush(userId);
    },

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
