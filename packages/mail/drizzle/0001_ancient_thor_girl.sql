CREATE TABLE "mail"."read_failures" (
	"user_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "read_failures_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "mail"."processed" DROP CONSTRAINT "processed_outcome";--> statement-breakpoint
ALTER TABLE "mail"."processed" ADD CONSTRAINT "processed_outcome" CHECK ("mail"."processed"."outcome" in ('applied', 'noted', 'ignored', 'unmatched', 'review', 'disagreed', 'failed'));