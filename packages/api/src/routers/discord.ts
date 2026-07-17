import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import * as discordClient from "@kan/discord";

import type { Permission } from "../utils/permissions";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertPermission } from "../utils/permissions";

const workspaceInput = z.object({ workspacePublicId: z.string().min(12) });

async function getAuthorizedWorkspace(
  ctx: { db: dbClient; user: { id: string } | null | undefined },
  workspacePublicId: string,
  permission: Permission,
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

  await assertPermission(ctx.db, userId, workspace.id, permission);

  return { workspace, userId };
}

export const discordRouter = createTRPCRouter({
  getStatus: protectedProcedure
    .input(workspaceInput)
    .output(
      z.object({
        connected: z.boolean(),
        guildId: z.string().nullable(),
        guildName: z.string().nullable(),
        inviteUrl: z.string().nullable(),
        botConfigured: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      return {
        connected: !!connection,
        guildId: connection?.guildId ?? null,
        guildName: connection?.guildName ?? null,
        inviteUrl: discordClient.getBotInviteUrl(),
        botConfigured: discordClient.isDiscordConfigured(),
      };
    }),

  connect: protectedProcedure
    .input(
      workspaceInput.extend({
        guildId: z.string().min(1).max(32).regex(/^\d+$/),
      }),
    )
    .output(z.object({ success: z.boolean(), guildName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace, userId } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "workspace:manage",
      );

      const guild = await discordClient.getGuild(input.guildId);

      if (!guild.success || !guild.data)
        throw new TRPCError({
          message:
            "Could not access this Discord server. Make sure the bot has been invited to it and the server ID is correct.",
          code: "BAD_REQUEST",
        });

      await discordRepo.create(ctx.db, {
        workspaceId: workspace.id,
        guildId: input.guildId,
        guildName: guild.data.name,
        createdBy: userId,
      });

      return { success: true, guildName: guild.data.name };
    }),

  disconnect: protectedProcedure
    .input(workspaceInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "workspace:manage",
      );

      await discordRepo.deleteByWorkspaceId(ctx.db, workspace.id);

      return { success: true };
    }),

  listChannels: protectedProcedure
    .input(workspaceInput)
    .output(z.array(z.object({ id: z.string(), name: z.string() })))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!connection)
        throw new TRPCError({
          message: "Discord is not connected for this workspace",
          code: "NOT_FOUND",
        });

      const channels = await discordClient.getTextChannels(connection.guildId);

      if (!channels.success || !channels.data)
        throw new TRPCError({
          message: channels.error ?? "Failed to fetch Discord channels",
          code: "INTERNAL_SERVER_ERROR",
        });

      return channels.data.map(({ id, name }) => ({ id, name }));
    }),

  listRoles: protectedProcedure
    .input(workspaceInput)
    .output(z.array(z.object({ id: z.string(), name: z.string() })))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!connection)
        throw new TRPCError({
          message: "Discord is not connected for this workspace",
          code: "NOT_FOUND",
        });

      const roles = await discordClient.getRoles(connection.guildId);

      if (!roles.success || !roles.data)
        throw new TRPCError({
          message: roles.error ?? "Failed to fetch Discord roles",
          code: "INTERNAL_SERVER_ERROR",
        });

      return roles.data.map(({ id, name }) => ({ id, name }));
    }),

  searchWorkspaceDiscordMembers: protectedProcedure
    .input(workspaceInput.extend({ query: z.string().min(1).max(100) }))
    .output(
      z.array(
        z.object({
          id: z.string(),
          username: z.string(),
          displayName: z.string(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!connection)
        throw new TRPCError({
          message: "Discord is not connected for this workspace",
          code: "NOT_FOUND",
        });

      const members = await discordClient.searchGuildMembers(
        connection.guildId,
        input.query,
      );

      if (!members.success || !members.data)
        throw new TRPCError({
          message: members.error ?? "Failed to search Discord members",
          code: "INTERNAL_SERVER_ERROR",
        });

      return members.data;
    }),
});
