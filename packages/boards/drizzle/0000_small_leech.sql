CREATE SCHEMA "boards";
--> statement-breakpoint
CREATE TABLE "boards"."directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ats" text NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"host" text,
	"marked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_board" UNIQUE("ats","token")
);
