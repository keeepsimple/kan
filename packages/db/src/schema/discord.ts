import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const discordBehaviours = ["create_thread", "notify"] as const;
export type DiscordBehaviour = (typeof discordBehaviours)[number];

export const workspaceDiscord = pgTable("workspace_discord", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number" })
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  guildId: varchar("guildId", { length: 32 }).notNull(),
  guildName: varchar("guildName", { length: 255 }),
  createdBy: uuid("createdBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}).enableRLS();

export const workspaceDiscordRelations = relations(
  workspaceDiscord,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceDiscord.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
