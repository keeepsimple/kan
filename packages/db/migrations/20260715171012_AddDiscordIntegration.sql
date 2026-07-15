CREATE TABLE IF NOT EXISTS "workspace_discord" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspaceId" bigint NOT NULL,
	"guildId" varchar(32) NOT NULL,
	"guildName" varchar(255),
	"createdBy" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_discord_workspaceId_unique" UNIQUE("workspaceId")
);
--> statement-breakpoint
ALTER TABLE "workspace_discord" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "discordChannelId" varchar(32);--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "discordThreadId" varchar(32);--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "discordBehaviour" varchar(16);--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "discordRoleIds" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_discord" ADD CONSTRAINT "workspace_discord_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_discord" ADD CONSTRAINT "workspace_discord_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
