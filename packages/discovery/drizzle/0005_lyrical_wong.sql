CREATE TABLE "discovery"."request_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discovery"."request_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"api" text NOT NULL,
	"key_position" integer NOT NULL,
	"publisher" text,
	"query" text NOT NULL,
	"status" integer,
	"failure" text,
	"jobs_returned" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "request_log_publisher_idx" ON "discovery"."request_log" USING btree ("publisher","id");