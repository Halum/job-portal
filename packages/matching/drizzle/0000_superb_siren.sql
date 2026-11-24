CREATE SCHEMA "matching";
--> statement-breakpoint
CREATE TABLE "matching"."candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"prerank_score" integer NOT NULL,
	"unknown_location" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_target_job" UNIQUE("target_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "matching"."global_defaults" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"criteria" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "matching"."candidates" ADD CONSTRAINT "candidates_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "matching"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidates_user_idx" ON "matching"."candidates" USING btree ("user_id","target_id");