CREATE SCHEMA "pipeline";
--> statement-breakpoint
CREATE TABLE "pipeline"."runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"status" text NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"new_postings" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status" CHECK ("pipeline"."runs"."status" in ('running', 'completed', 'completed_with_errors', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running" ON "pipeline"."runs" USING btree ("user_id","source_id") WHERE "pipeline"."runs"."status" = 'running';