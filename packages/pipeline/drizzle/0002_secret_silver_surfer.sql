ALTER TABLE "pipeline"."runs" ADD COLUMN "scored" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline"."runs" ADD COLUMN "tagged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline"."runs" ADD COLUMN "ai_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline"."runs" ADD COLUMN "ai_cost_usd" double precision;