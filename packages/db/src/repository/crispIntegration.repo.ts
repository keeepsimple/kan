import { and, eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { crispIntegrations } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const create = async (
  db: dbClient,
  input: {
    workspaceId: number;
    crispWebsiteId: string;
    listId: number;
    webhookSecret: string;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(crispIntegrations)
    .values({
      publicId: generateUID(),
      workspaceId: input.workspaceId,
      crispWebsiteId: input.crispWebsiteId,
      listId: input.listId,
      webhookSecret: input.webhookSecret,
      createdBy: input.createdBy,
    })
    .returning({
      publicId: crispIntegrations.publicId,
      crispWebsiteId: crispIntegrations.crispWebsiteId,
      webhookSecret: crispIntegrations.webhookSecret,
      active: crispIntegrations.active,
      createdAt: crispIntegrations.createdAt,
    });

  return result ?? null;
};

export const getByWorkspaceId = async (db: dbClient, workspaceId: number) => {
  const result = await db.query.crispIntegrations.findFirst({
    columns: {
      publicId: true,
      crispWebsiteId: true,
      webhookSecret: true,
      active: true,
      createdAt: true,
    },
    where: eq(crispIntegrations.workspaceId, workspaceId),
    with: {
      list: {
        columns: { publicId: true, name: true },
        with: {
          board: { columns: { publicId: true, name: true } },
        },
      },
    },
  });

  return result ?? null;
};

export const getActiveBySecret = async (db: dbClient, secret: string) => {
  const result = await db.query.crispIntegrations.findFirst({
    columns: {
      id: true,
      workspaceId: true,
      crispWebsiteId: true,
      listId: true,
      createdBy: true,
    },
    where: and(
      eq(crispIntegrations.webhookSecret, secret),
      eq(crispIntegrations.active, true),
    ),
    with: {
      list: {
        columns: { publicId: true, name: true, deletedAt: true },
        with: {
          board: { columns: { publicId: true, name: true } },
        },
      },
    },
  });

  return result ?? null;
};

export const hardDeleteByWorkspaceId = (db: dbClient, workspaceId: number) => {
  return db
    .delete(crispIntegrations)
    .where(eq(crispIntegrations.workspaceId, workspaceId));
};
