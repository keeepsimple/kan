import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { lists } from "./lists";
import { users } from "./users";
import { workspaces } from "./workspaces";

export const crispIntegrations = pgTable("crisp_integrations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: varchar("publicId", { length: 12 }).notNull().unique(),
  workspaceId: bigint("workspaceId", { mode: "number" })
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  crispWebsiteId: varchar("crispWebsiteId", { length: 255 }).notNull(),
  listId: bigint("listId", { mode: "number" })
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  webhookSecret: text("webhookSecret").notNull().unique(),
  createdBy: uuid("createdBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
}).enableRLS();

export const crispIntegrationsRelations = relations(
  crispIntegrations,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [crispIntegrations.workspaceId],
      references: [workspaces.id],
    }),
    list: one(lists, {
      fields: [crispIntegrations.listId],
      references: [lists.id],
    }),
    createdByUser: one(users, {
      fields: [crispIntegrations.createdBy],
      references: [users.id],
    }),
  }),
);
