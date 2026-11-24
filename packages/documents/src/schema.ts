import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Each module owns one Postgres schema; no other module queries it. */
export const documentsSchema = pgSchema('documents');

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const FILE_KINDS = ['master_resume', 'master_cover_letter', 'photo'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const MASTER_KINDS = ['master_resume', 'master_cover_letter'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

export const CAREER_ITEM_KINDS = ['work_experience', 'experience_point'] as const;
export type CareerItemKind = (typeof CAREER_ITEM_KINDS)[number];

export const REVISION_REASONS = ['import'] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];

export const REVISION_ACTORS = ['user', 'skill'] as const;
export type RevisionActor = (typeof REVISION_ACTORS)[number];

const inList = (values: readonly string[]): ReturnType<typeof sql.raw> =>
  sql.raw(values.map((v) => `'${v}'`).join(', '));

/** File metadata. The bytes live in their own table so listings never read them. */
export const files = documentsSchema.table(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<FileKind>().notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('files_user_kind_idx').on(t.userId, t.kind, t.createdAt),
    check('files_kind', sql`${t.kind} in (${inList(FILE_KINDS)})`),
  ],
);

export const fileBytes = documentsSchema.table('file_bytes', {
  fileId: uuid('file_id')
    .primaryKey()
    .references(() => files.id),
  bytes: bytea('bytes').notNull(),
});

/** The file currently registered as the user's Master resume or Master cover letter. Older uploads stay in files. */
export const masterDocuments = documentsSchema.table(
  'master_documents',
  {
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<MasterKind>().notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind] }),
    check('master_documents_kind', sql`${t.kind} in (${inList(MASTER_KINDS)})`),
  ],
);

/** Career bank items. A Work experience has no parent; an Experience point has its Work experience. */
export const careerItems = documentsSchema.table(
  'career_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<CareerItemKind>().notNull(),
    parentId: uuid('parent_id'),
    position: integer('position').notNull(),
    value: jsonb('value').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('career_items_user_idx').on(t.userId, t.kind, t.position),
    check('career_items_kind', sql`${t.kind} in (${inList(CAREER_ITEM_KINDS)})`),
  ],
);

/** Append-only history: one row per change to a Career bank item. */
export const careerRevisions = documentsSchema.table(
  'career_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    itemKind: text('item_kind').$type<CareerItemKind>().notNull(),
    itemId: uuid('item_id').notNull(),
    oldValue: jsonb('old_value').$type<Record<string, unknown>>(),
    newValue: jsonb('new_value').$type<Record<string, unknown>>().notNull(),
    reason: text('reason').$type<RevisionReason>().notNull(),
    actor: text('actor').$type<RevisionActor>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('career_revisions_item_idx').on(t.userId, t.itemId, t.createdAt),
    check('career_revisions_reason', sql`${t.reason} in (${inList(REVISION_REASONS)})`),
    check('career_revisions_actor', sql`${t.actor} in (${inList(REVISION_ACTORS)})`),
  ],
);
