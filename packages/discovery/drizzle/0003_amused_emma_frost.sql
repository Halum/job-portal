ALTER TABLE "discovery"."postings" ADD COLUMN "url_key" text;--> statement-breakpoint
CREATE INDEX "postings_url_key_idx" ON "discovery"."postings" USING btree ("user_id","url_key");