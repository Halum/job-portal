CREATE SCHEMA "discovery";
--> statement-breakpoint
CREATE TABLE "discovery"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery"."postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"source_posting_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"location" text,
	"url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postings_identity" UNIQUE("user_id","source_id","source_posting_id")
);
--> statement-breakpoint
ALTER TABLE "discovery"."postings" ADD CONSTRAINT "postings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "discovery"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "discovery"."jobs" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "postings_job_idx" ON "discovery"."postings" USING btree ("job_id");