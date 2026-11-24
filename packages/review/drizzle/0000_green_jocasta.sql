CREATE SCHEMA "review";
--> statement-breakpoint
CREATE TABLE "review"."items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" jsonb NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "items_user_kind_subject" UNIQUE("user_id","kind","subject"),
	CONSTRAINT "items_kind" CHECK ("review"."items"."kind" in ('ai_merge', 'ai_fit_rejection', 'mail_match')),
	CONSTRAINT "items_status" CHECK ("review"."items"."status" in ('pending', 'confirmed', 'disagreed'))
);
--> statement-breakpoint
CREATE INDEX "items_user_status_idx" ON "review"."items" USING btree ("user_id","status","kind");