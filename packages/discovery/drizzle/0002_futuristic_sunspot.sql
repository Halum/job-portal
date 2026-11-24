CREATE TABLE "discovery"."merge_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_a" uuid NOT NULL,
	"job_b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_checks_pair" UNIQUE("user_id","job_a","job_b")
);
--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "discovery"."jobs" ADD CONSTRAINT "jobs_merged_into_jobs_id_fk" FOREIGN KEY ("merged_into") REFERENCES "discovery"."jobs"("id") ON DELETE no action ON UPDATE no action;