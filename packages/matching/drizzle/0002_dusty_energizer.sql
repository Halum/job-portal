CREATE TABLE "matching"."tag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_overrides_target_job" UNIQUE("target_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "matching"."tag_overrides" ADD CONSTRAINT "tag_overrides_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "matching"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_overrides_user_idx" ON "matching"."tag_overrides" USING btree ("user_id","created_at");