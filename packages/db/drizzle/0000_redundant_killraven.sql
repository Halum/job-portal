CREATE TYPE "public"."job_status" AS ENUM('unenriched', 'matched', 'filtered_out', 'enrichment_failed');--> statement-breakpoint
CREATE TYPE "public"."prompt_role" AS ENUM('filter', 'summary');--> statement-breakpoint
CREATE TYPE "public"."error_stage" AS ENUM('scrape', 'enrichment', 'webhook');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"location" text,
	"apply_url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'unenriched' NOT NULL,
	"enrichment_json" jsonb,
	"prompt_versions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	CONSTRAINT "jobs_source_external_id_unique" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text,
	"role" "prompt_role" NOT NULL,
	"version" integer NOT NULL,
	"template" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "errors" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text,
	"job_id" bigint,
	"stage" "error_stage" NOT NULL,
	"attempts" integer NOT NULL,
	"error_message" text NOT NULL,
	"error_stack" text,
	"payload" jsonb,
	"webhook_delivered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "errors" ADD CONSTRAINT "errors_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_status_enriched_at_id_idx" ON "jobs" USING btree ("status","enriched_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_source_role_version_unique" ON "prompts" USING btree ("source","role","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_one_active_per_source_role_idx" ON "prompts" USING btree ("source","role") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "errors_stage_created_at_idx" ON "errors" USING btree ("stage","created_at");