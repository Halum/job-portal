CREATE TABLE "notifications"."watermarks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"through" timestamp with time zone NOT NULL
);
