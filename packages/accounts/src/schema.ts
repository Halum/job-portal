import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const accountsSchema = pgSchema('accounts');

export const users = accountsSchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
