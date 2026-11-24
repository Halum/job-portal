CREATE SCHEMA "documents";
--> statement-breakpoint
CREATE TABLE "documents"."career_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_items_kind" CHECK ("documents"."career_items"."kind" in ('work_experience', 'experience_point'))
);
--> statement-breakpoint
CREATE TABLE "documents"."career_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_revisions_reason" CHECK ("documents"."career_revisions"."reason" in ('import')),
	CONSTRAINT "career_revisions_actor" CHECK ("documents"."career_revisions"."actor" in ('user', 'skill'))
);
--> statement-breakpoint
CREATE TABLE "documents"."file_bytes" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_kind" CHECK ("documents"."files"."kind" in ('master_resume', 'master_cover_letter', 'photo'))
);
--> statement-breakpoint
CREATE TABLE "documents"."master_documents" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_documents_user_id_kind_pk" PRIMARY KEY("user_id","kind"),
	CONSTRAINT "master_documents_kind" CHECK ("documents"."master_documents"."kind" in ('master_resume', 'master_cover_letter'))
);
--> statement-breakpoint
ALTER TABLE "documents"."file_bytes" ADD CONSTRAINT "file_bytes_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "documents"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents"."master_documents" ADD CONSTRAINT "master_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "documents"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "career_items_user_idx" ON "documents"."career_items" USING btree ("user_id","kind","position");--> statement-breakpoint
CREATE INDEX "career_revisions_item_idx" ON "documents"."career_revisions" USING btree ("user_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "files_user_kind_idx" ON "documents"."files" USING btree ("user_id","kind","created_at");