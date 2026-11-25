CREATE TABLE "documents"."career_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid,
	"parent_id" uuid,
	"value" jsonb,
	"base_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_overrides_action" CHECK ("documents"."career_overrides"."action" in ('hide', 'replace', 'add')),
	CONSTRAINT "career_overrides_item_kind" CHECK ("documents"."career_overrides"."item_kind" in ('work_experience', 'experience_point', 'resume_entry', 'cover_letter_paragraph')),
	CONSTRAINT "career_overrides_shape" CHECK (("documents"."career_overrides"."action" = 'hide' and "documents"."career_overrides"."item_id" is not null and "documents"."career_overrides"."value" is null)
        or ("documents"."career_overrides"."action" = 'replace' and "documents"."career_overrides"."item_id" is not null and "documents"."career_overrides"."value" is not null)
        or ("documents"."career_overrides"."action" = 'add' and "documents"."career_overrides"."item_id" is null and "documents"."career_overrides"."value" is not null))
);
--> statement-breakpoint
ALTER TABLE "documents"."career_overrides" ADD CONSTRAINT "career_overrides_item_id_career_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "documents"."career_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "career_overrides_target_idx" ON "documents"."career_overrides" USING btree ("user_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "career_overrides_item" ON "documents"."career_overrides" USING btree ("user_id","target_id","item_id") WHERE "documents"."career_overrides"."action" in ('hide', 'replace');--> statement-breakpoint
ALTER TABLE "documents"."career_revisions" ADD CONSTRAINT "career_revisions_item_kind" CHECK ("documents"."career_revisions"."item_kind" in ('work_experience', 'experience_point', 'resume_entry', 'outline_section', 'cover_letter_paragraph', 'writing_style', 'contact', 'override'));