import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { env } from "next-runtime-env";
import { z } from "zod";

import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertPermission } from "../utils/permissions";

const connectionSchema = z.object({
  publicId: z.string(),
  crispWebsiteId: z.string(),
  webhookUrl: z.string(),
  active: z.boolean(),
  createdAt: z.date(),
  list: z.object({ publicId: z.string(), name: z.string() }),
  board: z.object({ publicId: z.string(), name: z.string() }),
});

function buildWebhookUrl(secret: string) {
  return `${env("NEXT_PUBLIC_BASE_URL")}/api/integrations/crisp/${secret}`;
}

async function getAuthorizedWorkspace(
  ctx: { db: never; user?: { id: string } | null },
  workspacePublicId: string,
) {
  const userId = ctx.user?.id;

  if (!userId)
    throw new TRPCError({
      message: "User not authenticated",
      code: "UNAUTHORIZED",
    });

  const workspace = await workspaceRepo.getByPublicId(
    ctx.db,
    workspacePublicId,
  );

  if (!workspace)
    throw new TRPCError({
      message: "Workspace not found",
      code: "NOT_FOUND",
    });

  await assertPermission(ctx.db, userId, workspace.id, "workspace:manage");

  return { userId, workspace };
}

export const crispIntegrationRouter = createTRPCRouter({
  get: protectedProcedure
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(connectionSchema.nullable())
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      const integration = await crispIntegrationRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!integration) return null;

      return {
        publicId: integration.publicId,
        crispWebsiteId: integration.crispWebsiteId,
        webhookUrl: buildWebhookUrl(integration.webhookSecret),
        active: integration.active,
        createdAt: integration.createdAt,
        list: {
          publicId: integration.list.publicId,
          name: integration.list.name,
        },
        board: {
          publicId: integration.list.board.publicId,
          name: integration.list.board.name,
        },
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        crispWebsiteId: z.string().min(1).max(255),
        listPublicId: z.string().min(12),
      }),
    )
    .output(connectionSchema)
    .mutation(async ({ ctx, input }) => {
      const { userId, workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list || list.workspaceId !== workspace.id)
        throw new TRPCError({
          message: "List not found",
          code: "NOT_FOUND",
        });

      const existing = await crispIntegrationRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (existing)
        throw new TRPCError({
          message: "Crisp is already connected to this workspace",
          code: "CONFLICT",
        });

      const webhookSecret = crypto.randomBytes(32).toString("base64url");

      const result = await crispIntegrationRepo.create(ctx.db, {
        workspaceId: workspace.id,
        crispWebsiteId: input.crispWebsiteId,
        listId: list.id,
        webhookSecret,
        createdBy: userId,
      });

      if (!result)
        throw new TRPCError({
          message: "Unable to connect Crisp",
          code: "INTERNAL_SERVER_ERROR",
        });

      return {
        publicId: result.publicId,
        crispWebsiteId: result.crispWebsiteId,
        webhookUrl: buildWebhookUrl(result.webhookSecret),
        active: result.active,
        createdAt: result.createdAt,
        list: { publicId: list.publicId, name: list.name },
        board: { publicId: list.boardPublicId, name: list.boardName },
      };
    }),

  disconnect: protectedProcedure
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      await crispIntegrationRepo.hardDeleteByWorkspaceId(ctx.db, workspace.id);

      return { success: true };
    }),
});
