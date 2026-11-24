CREATE SCHEMA "tracker";
--> statement-breakpoint
CREATE TABLE "tracker"."job_state" (
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"application_status" text,
	"furthest_stage" text,
	"applied_on" date,
	"apply_by" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_state_user_id_job_id_pk" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "tracker"."notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker"."timeline_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"field" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"actor" text NOT NULL,
	"evidence" text,
	"furthest_before" text,
	"applied_on_before" date,
	"apply_by_before" date,
	"undoes" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE INDEX "job_state_status_idx" ON "tracker"."job_state" USING btree ("user_id","application_status");--> statement-breakpoint
CREATE INDEX "notes_job_idx" ON "tracker"."notes" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "timeline_job_idx" ON "tracker"."timeline_events" USING btree ("user_id","job_id","seq");