import { and, asc, desc, eq, inArray, lte, max } from 'drizzle-orm';
import type { Db, DbTx } from '@job-portal/db';
import type { Discovery, DiscoveryState } from '@job-portal/discovery';
import {
  checkApplicationChange,
  checkDiscoveryChange,
  nextFurthest,
  type Actor,
  type ApplicationStatus,
  type Stage,
} from './model';
import { jobState, notes, timelineEvents } from './schema';

export interface ApplicationTracking {
  applicationStatus: ApplicationStatus | null;
  furthestStage: Stage | null;
  /** YYYY-MM-DD in the user's timezone. */
  appliedOn: string | null;
  applyBy: string | null;
}

export interface JobTracking extends ApplicationTracking {
  discoveryState: DiscoveryState;
}

export interface TimelineEvent {
  id: string;
  field: 'discovery' | 'application';
  from: string | null;
  to: string | null;
  actor: Actor;
  evidence: string | null;
  /** The id of the event this one reverted, for an undo. */
  undoes: string | null;
  createdAt: Date;
}

export interface Note {
  id: string;
  text: string;
  createdAt: Date;
}

export interface ApplicationChange {
  to: ApplicationStatus;
  actor: Actor;
  evidence?: string;
  /** Applied only: YYYY-MM-DD, default today in `timezone`. */
  appliedOn?: string;
  /** Applied only: YYYY-MM-DD, the latest date the user plans to apply. */
  applyBy?: string;
  /** The user's IANA timezone, used for today's date. */
  timezone: string;
}

export interface GoneColdMove {
  jobId: string;
  /** Calendar days since the last Timeline event. */
  daysSilent: number;
  from: ApplicationStatus;
}

/** A change the state model refuses; the message says why. */
export class TrackerError extends Error {}

export interface Tracker {
  /** The application side of each Job; one without a row has no application. */
  getStates: (userId: string, jobIds: string[]) => Promise<Map<string, ApplicationTracking>>;
  /** Ids of the user's Jobs matching the application filters, for Discovery.listJobs to restrict to. */
  findJobIds: (
    userId: string,
    filter: { applicationStatus?: ApplicationStatus; applyByOnOrBefore?: string },
  ) => Promise<string[]>;
  setDiscoveryState: (
    userId: string,
    jobId: string,
    to: DiscoveryState,
    actor: Actor,
    evidence?: string,
  ) => Promise<JobTracking>;
  /** Pass the caller's transaction to make the change part of it (the Mail ledger row commits with it). */
  setApplicationStatus: (
    userId: string,
    jobId: string,
    change: ApplicationChange,
    tx?: DbTx,
  ) => Promise<JobTracking>;
  /** Reverts the last state-changing event as a new event; refused if that event is itself an undo. */
  undoLastChange: (userId: string, jobId: string, actor: Actor) => Promise<JobTracking>;
  addNote: (userId: string, jobId: string, text: string, tx?: DbTx) => Promise<Note>;
  /**
   * The Gone cold check: moves every Applied, Screening, Interview or Offer Job whose last Timeline event
   * (any actor, undo included, notes not) is N or more calendar days old in the user's timezone to Gone cold,
   * actor system. Idempotent and safe with several workers: each move takes the Job lock and rechecks inside it.
   */
  goneCold: (
    userId: string,
    options: { days: number; timezone: string },
  ) => Promise<GoneColdMove[]>;
  getTimeline: (
    userId: string,
    jobId: string,
  ) => Promise<{ events: TimelineEvent[]; notes: Note[] }>;
}

type StateRow = typeof jobState.$inferSelect;

const NO_APPLICATION: ApplicationTracking = {
  applicationStatus: null,
  furthestStage: null,
  appliedOn: null,
  applyBy: null,
};

const view = (r: StateRow): ApplicationTracking => ({
  applicationStatus: r.applicationStatus as ApplicationStatus | null,
  furthestStage: r.furthestStage as Stage | null,
  appliedOn: r.appliedOn,
  applyBy: r.applyBy,
});

/** Statuses the Gone cold check looks at. */
const WAITING: ApplicationStatus[] = ['applied', 'screening', 'interview', 'offer'];

/** Whole calendar days from one YYYY-MM-DD to another. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(label: string, value: string): string {
  const ok = DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!ok) throw new TrackerError(`${label} must be a date as YYYY-MM-DD`);
  return value;
}

/** Today's calendar date in the user's timezone (en-CA formats as YYYY-MM-DD). */
const todayIn = (timezone: string, now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);

export function createTracker(
  db: Db,
  discovery: Discovery,
  now: () => Date = () => new Date(),
): Tracker {
  interface Locked {
    discoveryState: DiscoveryState;
    row: StateRow;
  }

  /**
   * The Job lock: the Job row in Discovery is locked until the transaction ends, so every Timeline write
   * for one Job is serialized; the tracker row is created if missing.
   */
  async function lock(tx: DbTx, userId: string, jobId: string): Promise<Locked> {
    const job = await discovery.lockJob(tx, userId, jobId);
    if (!job) throw new TrackerError(`No Job ${jobId}`);
    await tx.insert(jobState).values({ userId, jobId }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(jobState)
      .where(and(eq(jobState.userId, userId), eq(jobState.jobId, jobId)))
      .for('update');
    if (!row) throw new Error('job state row missing after insert');
    return { discoveryState: job.discoveryState, row };
  }

  async function record(
    tx: DbTx,
    { row: before, discoveryState }: Locked,
    event: {
      field: 'discovery' | 'application';
      from: string | null;
      to: string | null;
      actor: Actor;
      evidence?: string;
      undoes?: string;
    },
    after: Partial<StateRow>,
    newDiscoveryState?: DiscoveryState,
  ): Promise<JobTracking> {
    await tx.insert(timelineEvents).values({
      userId: before.userId,
      jobId: before.jobId,
      field: event.field,
      fromValue: event.from,
      toValue: event.to,
      actor: event.actor,
      evidence: event.evidence ?? null,
      undoes: event.undoes ?? null,
      createdAt: now(),
      furthestBefore: before.furthestStage,
      appliedOnBefore: before.appliedOn,
      applyByBefore: before.applyBy,
    });
    const [row] = await tx
      .update(jobState)
      .set({ ...after, updatedAt: now() })
      .where(and(eq(jobState.userId, before.userId), eq(jobState.jobId, before.jobId)))
      .returning();
    if (!row) throw new Error('job state update returned no row');
    if (newDiscoveryState) {
      await discovery.setDiscoveryState(tx, before.userId, before.jobId, newDiscoveryState);
    }
    return { ...view(row), discoveryState: newDiscoveryState ?? discoveryState };
  }

  const inTx = <T>(outer: DbTx | undefined, fn: (tx: DbTx) => Promise<T>): Promise<T> =>
    outer ? fn(outer) : db.transaction(fn);

  const refuse = (reason: string | null): void => {
    if (reason) throw new TrackerError(reason);
  };

  return {
    async getStates(userId, jobIds) {
      const rows = jobIds.length
        ? await db
            .select()
            .from(jobState)
            .where(and(eq(jobState.userId, userId), inArray(jobState.jobId, jobIds)))
        : [];
      const byJob = new Map(rows.map((r) => [r.jobId, view(r)]));
      return new Map(jobIds.map((id) => [id, byJob.get(id) ?? NO_APPLICATION]));
    },

    async findJobIds(userId, { applicationStatus, applyByOnOrBefore }) {
      const rows = await db
        .select({ jobId: jobState.jobId })
        .from(jobState)
        .where(
          and(
            eq(jobState.userId, userId),
            applicationStatus ? eq(jobState.applicationStatus, applicationStatus) : undefined,
            applyByOnOrBefore
              ? lte(jobState.applyBy, checkDate('applyBy', applyByOnOrBefore))
              : undefined,
          ),
        );
      return rows.map((r) => r.jobId);
    },

    setDiscoveryState: (userId, jobId, to, actor, evidence) =>
      db.transaction(async (tx) => {
        const locked = await lock(tx, userId, jobId);
        refuse(
          checkDiscoveryChange(
            locked.discoveryState,
            to,
            locked.row.applicationStatus as ApplicationStatus | null,
            actor,
          ),
        );
        return record(
          tx,
          locked,
          { field: 'discovery', from: locked.discoveryState, to, actor, evidence },
          {},
          to,
        );
      }),

    setApplicationStatus: (userId, jobId, change, outer) =>
      inTx(outer, async (tx) => {
        if (change.to !== 'applied' && (change.appliedOn ?? change.applyBy) !== undefined) {
          throw new TrackerError('appliedOn and applyBy go with Applied only');
        }
        const locked = await lock(tx, userId, jobId);
        const row = locked.row;
        refuse(
          checkApplicationChange(
            { status: row.applicationStatus as ApplicationStatus | null, appliedOn: row.appliedOn },
            change.to,
            change.actor,
          ),
        );
        const after: Partial<StateRow> = {
          applicationStatus: change.to,
          furthestStage: nextFurthest(row.furthestStage as Stage | null, change.to),
        };
        if (change.to === 'applied') {
          after.appliedOn = change.appliedOn
            ? checkDate('appliedOn', change.appliedOn)
            : todayIn(change.timezone, now());
          after.applyBy = change.applyBy ? checkDate('applyBy', change.applyBy) : null;
        }
        return record(
          tx,
          locked,
          {
            field: 'application',
            from: row.applicationStatus,
            to: change.to,
            actor: change.actor,
            evidence: change.evidence,
          },
          after,
        );
      }),

    undoLastChange: (userId, jobId, actor) =>
      db.transaction(async (tx) => {
        const locked = await lock(tx, userId, jobId);
        const [last] = await tx
          .select()
          .from(timelineEvents)
          .where(and(eq(timelineEvents.userId, userId), eq(timelineEvents.jobId, jobId)))
          .orderBy(desc(timelineEvents.seq))
          .limit(1);
        if (!last) throw new TrackerError('nothing to undo');
        if (last.undoes) throw new TrackerError('the last change is already an undo');
        const field = last.field === 'discovery' ? 'discovery' : 'application';
        const event = {
          field,
          from: last.toValue,
          to: last.fromValue,
          actor,
          undoes: last.id,
        } as const;
        return field === 'discovery'
          ? record(tx, locked, event, {}, (last.fromValue ?? 'new') as DiscoveryState)
          : record(tx, locked, event, {
              applicationStatus: last.fromValue,
              furthestStage: last.furthestBefore,
              appliedOn: last.appliedOnBefore,
              applyBy: last.applyByBefore,
            });
      }),

    async goneCold(userId, { days, timezone }) {
      if (!Number.isInteger(days) || days < 1) {
        throw new TrackerError('gone cold days must be an integer of at least 1');
      }
      const lastEvent = max(timelineEvents.createdAt);
      const silentDays = (last: Date | null): number | null =>
        last === null ? null : daysBetween(todayIn(timezone, last), todayIn(timezone, now()));
      const waiting = await db
        .select({ jobId: jobState.jobId, last: lastEvent })
        .from(jobState)
        .innerJoin(
          timelineEvents,
          and(eq(timelineEvents.userId, jobState.userId), eq(timelineEvents.jobId, jobState.jobId)),
        )
        .where(and(eq(jobState.userId, userId), inArray(jobState.applicationStatus, WAITING)))
        .groupBy(jobState.jobId);
      const moves: GoneColdMove[] = [];
      for (const { jobId, last } of waiting) {
        const silentNow = silentDays(last);
        if (silentNow === null || silentNow < days) continue;
        const move = await db.transaction(async (tx): Promise<GoneColdMove | null> => {
          // A Job folded into another is gone for every writer: lockJob finds no row and it is skipped.
          const locked = await lock(tx, userId, jobId).catch((err: unknown) => {
            if (err instanceof TrackerError) return null;
            throw err;
          });
          if (locked === null) return null;
          // Recheck inside the lock: a set_status that won the race left a fresh event or another status.
          const from = locked.row.applicationStatus as ApplicationStatus | null;
          const [latest] = await tx
            .select({ last: lastEvent })
            .from(timelineEvents)
            .where(and(eq(timelineEvents.userId, userId), eq(timelineEvents.jobId, jobId)));
          const silent = silentDays(latest?.last ?? null);
          if (from === null || !WAITING.includes(from) || silent === null || silent < days) {
            return null;
          }
          await record(
            tx,
            locked,
            {
              field: 'application',
              from,
              to: 'gone_cold',
              actor: 'system',
              evidence: `Gone cold rule: no status change for ${String(days)} days (${String(silent)} days silent)`,
            },
            { applicationStatus: 'gone_cold' },
          );
          return { jobId, daysSilent: silent, from };
        });
        if (move) moves.push(move);
      }
      return moves;
    },

    async addNote(userId, jobId, text, tx) {
      const [note] = await (tx ?? db).insert(notes).values({ userId, jobId, text }).returning();
      if (!note) throw new Error('note insert returned no row');
      return { id: note.id, text: note.text, createdAt: note.createdAt };
    },

    async getTimeline(userId, jobId) {
      const [events, ns] = await Promise.all([
        db
          .select()
          .from(timelineEvents)
          .where(and(eq(timelineEvents.userId, userId), eq(timelineEvents.jobId, jobId)))
          .orderBy(asc(timelineEvents.seq)),
        db
          .select()
          .from(notes)
          .where(and(eq(notes.userId, userId), eq(notes.jobId, jobId)))
          .orderBy(asc(notes.createdAt)),
      ]);
      return {
        events: events.map((e) => ({
          id: e.id,
          field: e.field === 'discovery' ? 'discovery' : 'application',
          from: e.fromValue,
          to: e.toValue,
          actor: e.actor as Actor,
          evidence: e.evidence,
          undoes: e.undoes,
          createdAt: e.createdAt,
        })),
        notes: ns.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt })),
      };
    },
  };
}
