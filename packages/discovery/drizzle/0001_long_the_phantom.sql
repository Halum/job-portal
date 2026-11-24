CREATE TABLE "discovery"."merge_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"posting_id" uuid NOT NULL,
	"job_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_conflicts_posting_id_unique" UNIQUE("posting_id")
);
--> statement-breakpoint
CREATE TABLE "discovery"."never_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"posting_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "never_merge_pair" UNIQUE("posting_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "discovery"."splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_job_id" uuid NOT NULL,
	"new_job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD COLUMN "company_key" text;--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD COLUMN "url_key" text;--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD COLUMN "discovery_state" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery"."merge_conflicts" ADD CONSTRAINT "merge_conflicts_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "discovery"."postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery"."never_merge" ADD CONSTRAINT "never_merge_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "discovery"."postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery"."never_merge" ADD CONSTRAINT "never_merge_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "discovery"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery"."splits" ADD CONSTRAINT "splits_from_job_id_jobs_id_fk" FOREIGN KEY ("from_job_id") REFERENCES "discovery"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery"."splits" ADD CONSTRAINT "splits_new_job_id_jobs_id_fk" FOREIGN KEY ("new_job_id") REFERENCES "discovery"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD CONSTRAINT "jobs_company_key" UNIQUE("user_id","company_key");--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD CONSTRAINT "jobs_url_key" UNIQUE("user_id","url_key");