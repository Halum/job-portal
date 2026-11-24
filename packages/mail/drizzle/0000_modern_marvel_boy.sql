CREATE SCHEMA "mail";
--> statement-breakpoint
CREATE TABLE "mail"."cursors" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"leased_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail"."matches" (
	"user_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"suggested_job_id" uuid NOT NULL,
	"candidate_job_ids" jsonb NOT NULL,
	"summary" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "matches_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "mail"."processed" (
	"user_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"outcome" text NOT NULL,
	"job_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_user_id_message_id_pk" PRIMARY KEY("user_id","message_id"),
	CONSTRAINT "processed_outcome" CHECK ("mail"."processed"."outcome" in ('applied', 'noted', 'ignored', 'unmatched', 'review'))
);
--> statement-breakpoint
CREATE TABLE "mail"."unmatched" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"summary" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmatched_user_message" UNIQUE("user_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "cursors_lease_idx" ON "mail"."cursors" USING btree ("leased_until");