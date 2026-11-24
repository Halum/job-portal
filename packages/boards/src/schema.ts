import { boolean, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const boardsSchema = pgSchema('boards');

/** The Board directory: shared reference data, so no user id. */
export const directory = boardsSchema.table(
  'directory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** greenhouse, lever or ashby. */
    ats: text('ats').notNull(),
    /** The board id the ATS API takes. */
    token: text('token').notNull(),
    name: text('name').notNull(),
    /** Lever only: "eu" for boards on the EU host. */
    host: text('host'),
    /** True once the board has posted in Germany or remote EU; the only column the mark script writes. */
    marked: boolean('marked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('directory_board').on(t.ats, t.token)],
);

/** The Watchlist: boards one user narrows the fetch to. Owned by the user, so every query carries the user id. */
export const watchlist = boardsSchema.table(
  'watchlist',
  {
    userId: uuid('user_id').notNull(),
    ats: text('ats').notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // the unique index leads with user_id, so it also serves the per-user lookups
  (t) => [unique('watchlist_board').on(t.userId, t.ats, t.token)],
);
