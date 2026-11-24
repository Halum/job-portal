CREATE SCHEMA "ai";
--> statement-breakpoint
CREATE TABLE "ai"."calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runner" text NOT NULL,
	"model" text,
	"feature" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_outcome" CHECK ("ai"."calls"."outcome" in ('ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX "calls_user_idx" ON "ai"."calls" USING btree ("user_id","created_at");