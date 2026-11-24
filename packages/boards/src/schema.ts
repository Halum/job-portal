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
