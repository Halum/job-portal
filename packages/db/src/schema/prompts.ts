import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const promptRoleEnum = pgEnum('prompt_role', ['filter', 'summary']);

const isActiveTrue = sql`is_active = true`;

export const prompts = pgTable(
  'prompts',
  {
    id: serial('id').primaryKey(),

    // Nullable to allow a future global fallback; v1 always sets this.
    source: text('source'),
    role: promptRoleEnum('role').notNull(),

    // Auto-incremented per (source, role) by the admin API's insert transaction.
    version: integer('version').notNull(),
    template: text('template').notNull(),
    isActive: boolean('is_active').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('prompts_source_role_version_unique').on(
      table.source,
      table.role,
      table.version,
    ),
    // Enforces "only one active per (source, role)" at the DB level.
    uniqueIndex('prompts_one_active_per_source_role_idx')
      .on(table.source, table.role)
      .where(isActiveTrue),
  ],
);
