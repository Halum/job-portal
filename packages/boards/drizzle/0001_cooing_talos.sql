CREATE TABLE "boards"."watchlist" (
	"user_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_board" UNIQUE("user_id","ats","token")
);
