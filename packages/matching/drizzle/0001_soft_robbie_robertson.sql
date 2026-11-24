CREATE TABLE "matching"."scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"red_flags" jsonb NOT NULL,
	"languages" jsonb NOT NULL,
	"language_met" boolean,
	"tagged" boolean NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_target_job" UNIQUE("target_id","job_id"),
	CONSTRAINT "scores_range" CHECK ("matching"."scores"."score" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "matching"."scores" ADD CONSTRAINT "scores_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "matching"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scores_user_idx" ON "matching"."scores" USING btree ("user_id","target_id");