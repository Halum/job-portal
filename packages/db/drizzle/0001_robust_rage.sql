DROP INDEX "prompts_source_role_version_unique";--> statement-breakpoint
DROP INDEX "prompts_one_active_per_source_role_idx";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "prompt_versions";--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_source_role_unique" UNIQUE("source","role");