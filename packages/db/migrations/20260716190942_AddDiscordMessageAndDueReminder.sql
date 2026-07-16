ALTER TABLE "card" ADD COLUMN "dueReminderSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "discordMessageId" varchar(32);