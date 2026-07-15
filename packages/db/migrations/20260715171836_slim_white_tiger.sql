CREATE TABLE IF NOT EXISTS "crisp_integrations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"workspaceId" bigint NOT NULL,
	"crispWebsiteId" varchar(255) NOT NULL,
	"listId" bigint NOT NULL,
	"webhookSecret" text NOT NULL,
	"createdBy" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	CONSTRAINT "crisp_integrations_publicId_unique" UNIQUE("publicId"),
	CONSTRAINT "crisp_integrations_workspaceId_unique" UNIQUE("workspaceId"),
	CONSTRAINT "crisp_integrations_webhookSecret_unique" UNIQUE("webhookSecret")
);
--> statement-breakpoint
ALTER TABLE "crisp_integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crisp_integrations" ADD CONSTRAINT "crisp_integrations_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crisp_integrations" ADD CONSTRAINT "crisp_integrations_listId_list_id_fk" FOREIGN KEY ("listId") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crisp_integrations" ADD CONSTRAINT "crisp_integrations_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
