import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
export const documentsSchema = pgSchema('documents');

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const FILE_KINDS = ['master_resume', 'master_cover_letter', 'photo'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const MASTER_KINDS = ['master_resume', 'master_cover_letter'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

/** Kinds with exactly one item per user: a write to them updates it. */
export const SINGLETON_KINDS: readonly CareerItemKind[] = ['writing_style', 'contact'];

export const CAREER_ITEM_KINDS = [
  'work_experience',
  'experience_point',
  'resume_entry',
  'outline_section',
  'cover_letter_paragraph',
  'writing_style',
  'contact',
] as const;
export type CareerItemKind = (typeof CAREER_ITEM_KINDS)[number];

/** What a revision is about: a Career bank item kind, or a Career bank override. */
export const REVISION_ITEM_KINDS = [...CAREER_ITEM_KINDS, 'override'] as const;
export type RevisionItemKind = (typeof REVISION_ITEM_KINDS)[number];

export const OVERRIDE_ACTIONS = ['hide', 'replace', 'add'] as const;
export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

export const OVERRIDE_ITEM_KINDS = [
  'work_experience',
  'experience_point',
  'resume_entry',
  'cover_letter_paragraph',
] as const;
export type OverrideItemKind = (typeof OVERRIDE_ITEM_KINDS)[number];

export const REVISION_REASONS = [
  'import',
  'coaching',
  'enrichment',
  'user_edit',
  'hide',
  'restore',
] as const;
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

/** Career bank items. An Experience point has its Work experience and a Cover letter paragraph its Cover letter outline section as parent; the other kinds have none. */
export const careerItems = documentsSchema.table(
  'career_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<CareerItemKind>().notNull(),
    parentId: uuid('parent_id'),
    position: integer('position').notNull(),
    hidden: boolean('hidden').notNull().default(false),
    value: jsonb('value').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('career_items_user_idx').on(t.userId, t.kind, t.position),
    // One Writing style profile and one set of contact details per user.
    uniqueIndex('career_items_singleton')
      .on(t.userId, t.kind)
      .where(sql`${t.kind} in (${inList(SINGLETON_KINDS)})`),
    check('career_items_kind', sql`${t.kind} in (${inList(CAREER_ITEM_KINDS)})`),
  ],
);

/** Append-only history: one row per change to a Career bank item. */
export const careerRevisions = documentsSchema.table(
  'career_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    itemKind: text('item_kind').$type<RevisionItemKind>().notNull(),
    itemId: uuid('item_id').notNull(),
    oldValue: jsonb('old_value').$type<Record<string, unknown>>(),
    newValue: jsonb('new_value').$type<Record<string, unknown>>().notNull(),
    reason: text('reason').$type<RevisionReason>().notNull(),
    actor: text('actor').$type<RevisionActor>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('career_revisions_item_idx').on(t.userId, t.itemId, t.createdAt),
    check('career_revisions_item_kind', sql`${t.itemKind} in (${inList(REVISION_ITEM_KINDS)})`),
    check('career_revisions_reason', sql`${t.reason} in (${inList(REVISION_REASONS)})`),
    check('career_revisions_actor', sql`${t.actor} in (${inList(REVISION_ACTORS)})`),
  ],
);

/**
 * Career bank overrides: what one Target changes in the Career bank. A hide or replace names the item
 * (at most one per Target and item); an add holds the whole new value and, where the kind needs one, its parent
 * (a Career bank item, or a Target-added Work experience). The row is deleted when cleared: the history is in career_revisions.
 */
export const careerOverrides = documentsSchema.table(
  'career_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    targetId: uuid('target_id').notNull(),
    action: text('action').$type<OverrideAction>().notNull(),
    itemKind: text('item_kind').$type<OverrideItemKind>().notNull(),
    itemId: uuid('item_id').references(() => careerItems.id),
    parentId: uuid('parent_id'),
    value: jsonb('value').$type<Record<string, unknown>>(),
    baseRevisionId: uuid('base_revision_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('career_overrides_target_idx').on(t.userId, t.targetId),
    uniqueIndex('career_overrides_item')
      .on(t.userId, t.targetId, t.itemId)
      .where(sql`${t.action} in ('hide', 'replace')`),
    check('career_overrides_action', sql`${t.action} in (${inList(OVERRIDE_ACTIONS)})`),
    check('career_overrides_item_kind', sql`${t.itemKind} in (${inList(OVERRIDE_ITEM_KINDS)})`),
    check(
      'career_overrides_shape',
      sql`(${t.action} = 'hide' and ${t.itemId} is not null and ${t.value} is null)
        or (${t.action} = 'replace' and ${t.itemId} is not null and ${t.value} is not null)
        or (${t.action} = 'add' and ${t.itemId} is null and ${t.value} is not null)`,
    ),
  ],
);
