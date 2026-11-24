import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const notificationsSchema = pgSchema('notifications');

export const MESSAGE_KINDS = ['digest', 'alert', 'line'] as const;
/** digest: new matches; alert: a failure or recovery; line: one short status line (Gone cold, a Gmail status change). */
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** pending: not delivered yet; sent: delivered; folded: merged into a later digest. */
export const MESSAGE_STATUSES = ['pending', 'sent', 'folded'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** The outbox: every digest and alert, stored before it is sent. */
export const messages = notificationsSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No foreign key to accounts.users: modules never reference each other's schema.
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<MessageKind>().notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<MessageStatus>().notNull().default('pending'),
    /** Send attempts so far, across runs. */
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('messages_kind', sql`${t.kind} in (${inList(MESSAGE_KINDS)})`),
    check('messages_status', sql`${t.status} in (${inList(MESSAGE_STATUSES)})`),
    index('messages_user_status_idx').on(t.userId, t.status, t.createdAt),
  ],
);

/** Job and Target pairs a digest has listed: a pair is claimed here once, so it is never listed twice. */
export const digestPairs = notificationsSchema.table(
  'digest_pairs',
  {
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    targetId: uuid('target_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.jobId, t.targetId] })],
);

/** How far a user's new tags have been looked at: only pairs scored after it are looked up, and it moves once a digest is stored. */
export const watermarks = notificationsSchema.table('watermarks', {
  userId: uuid('user_id').primaryKey(),
  through: timestamp('through', { withTimezone: true }).notNull(),
});

/** The failure types that are failing now, one row each; the row is what makes an alert fire once. */
export const openFailures = notificationsSchema.table(
  'open_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** A type such as source:greenhouse; the key space stays open for later modules. */
    key: text('key').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('open_failures_user_key').on(t.userId, t.key)],
);
