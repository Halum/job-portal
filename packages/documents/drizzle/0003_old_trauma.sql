CREATE TABLE "documents"."application_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"resume" jsonb NOT NULL,
	"letter" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"questions_asked" jsonb NOT NULL,
	"resume_pdf_file_id" uuid NOT NULL,
	"letter_pdf_file_id" uuid NOT NULL,
	"resume_pages" integer NOT NULL,
	"letter_pages" integer NOT NULL,
	"resume_over_cap" boolean NOT NULL,
	"letter_over_cap" boolean NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_packets_version_positive" CHECK ("documents"."application_packets"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "documents"."files" DROP CONSTRAINT "files_kind";--> statement-breakpoint
ALTER TABLE "documents"."application_packets" ADD CONSTRAINT "application_packets_resume_pdf_file_id_files_id_fk" FOREIGN KEY ("resume_pdf_file_id") REFERENCES "documents"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents"."application_packets" ADD CONSTRAINT "application_packets_letter_pdf_file_id_files_id_fk" FOREIGN KEY ("letter_pdf_file_id") REFERENCES "documents"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_packets_version" ON "documents"."application_packets" USING btree ("user_id","job_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "application_packets_sent" ON "documents"."application_packets" USING btree ("user_id","job_id") WHERE "documents"."application_packets"."sent";--> statement-breakpoint
ALTER TABLE "documents"."files" ADD CONSTRAINT "files_kind" CHECK ("documents"."files"."kind" in ('master_resume', 'master_cover_letter', 'photo', 'resume_pdf', 'letter_pdf'));