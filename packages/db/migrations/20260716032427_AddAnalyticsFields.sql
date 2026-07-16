ALTER TABLE "card" ADD COLUMN "completedAt" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "completedBy" uuid;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "isCompleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "autoArchiveEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "autoArchiveDays" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card" ADD CONSTRAINT "card_completedBy_user_id_fk" FOREIGN KEY ("completedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
