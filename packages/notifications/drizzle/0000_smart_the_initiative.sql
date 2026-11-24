CREATE SCHEMA "notifications";
--> statement-breakpoint
CREATE TABLE "notifications"."digest_pairs" (
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_pairs_user_id_job_id_target_id_pk" PRIMARY KEY("user_id","job_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "notifications"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "messages_kind" CHECK ("notifications"."messages"."kind" in ('digest', 'alert')),
	CONSTRAINT "messages_status" CHECK ("notifications"."messages"."status" in ('pending', 'sent', 'folded'))
);
--> statement-breakpoint
CREATE TABLE "notifications"."open_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_user_status_idx" ON "notifications"."messages" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "open_failures_user_key" ON "notifications"."open_failures" USING btree ("user_id","key");