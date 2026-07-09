import { pgEnum, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const promptRoleEnum = pgEnum('prompt_role', ['filter', 'summary']);

export const prompts = pgTable(
  'prompts',
  {
    id: serial('id').primaryKey(),

    // Nullable to allow a future global fallback; v1 always sets this.
    source: text('source'),
    role: promptRoleEnum('role').notNull(),

    template: text('template').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  // Destructive prompts: exactly one row per (source, role); edits overwrite.
  (table) => [unique('prompts_source_role_unique').on(table.source, table.role)],
);
