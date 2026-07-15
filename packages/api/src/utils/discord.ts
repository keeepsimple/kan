import { TRPCError } from "@trpc/server";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";
import { createLogger } from "@kan/logger";

const log = createLogger("discord");

export const parseRoleIds = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
};

/** Discord notify lists only receive moved cards — direct creation is blocked. */
export const assertListAllowsCardCreation = (list: {
  discordBehaviour?: string | null;
}) => {
  if (list.discordBehaviour === "notify") {
    throw new TRPCError({
      message:
        "Cards cannot be created directly in a Discord notify list — move a card into it instead",
      code: "BAD_REQUEST",
    });
  }
};

export const notifyCardCreated = async (
  db: dbClient,
  args: {
    cardId: number;
    cardTitle: string;
    boardName: string;
    workspaceId: number;
    discordChannelId: string | null;
    discordBehaviour: string | null;
    discordRoleIds: string | null;
  },
): Promise<void> => {
  try {
    if (args.discordBehaviour !== "create_thread" || !args.discordChannelId)
      return;

    const connection = await discordRepo.getByWorkspaceId(
      db,
      args.workspaceId,
    );
    if (!connection) return;

    const thread = await discordClient.createThread(
      args.discordChannelId,
      args.cardTitle,
    );
    if (!thread.success || !thread.data) {
      log.error(
        { error: thread.error, cardId: args.cardId },
        "Failed to create Discord thread",
      );
      return;
    }

    await discordRepo.setCardDiscordThreadId(db, args.cardId, thread.data.id);

    const roleIds = parseRoleIds(args.discordRoleIds);
    const mentions = discordClient.buildRoleMentions(roleIds);
    const content = `${mentions ? `${mentions} ` : ""}${args.cardTitle} — ${args.boardName}`;

    const message = await discordClient.postMessage(
      thread.data.id,
      content,
      roleIds,
    );
    if (!message.success) {
      log.error(
        { error: message.error, cardId: args.cardId },
        "Failed to post Discord thread message",
      );
    }
  } catch (error) {
    log.error(
      { err: error, cardId: args.cardId },
      "Discord notifyCardCreated failed",
    );
  }
};

export const notifyCardMoved = async (
  db: dbClient,
  args: {
    cardTitle: string;
    boardName: string;
    userName: string | null;
    workspaceId: number;
    newListDiscordBehaviour: string | null | undefined;
    cardDiscordThreadId: string | null | undefined;
    newListBoardId: number;
  },
): Promise<void> => {
  try {
    if (args.newListDiscordBehaviour !== "notify") return;

    const connection = await discordRepo.getByWorkspaceId(
      db,
      args.workspaceId,
    );
    if (!connection) return;

    let targetId = args.cardDiscordThreadId ?? null;
    if (!targetId) {
      // Card was created in a plain list and has no thread — fall back to the board channel
      targetId = await discordRepo.getBoardDiscordChannelId(
        db,
        args.newListBoardId,
      );
    }
    if (!targetId) return;

    const content = `${args.cardTitle} ${args.boardName} - ${args.userName ?? "unknown"}`;

    const result = await discordClient.postMessage(targetId, content);
    if (!result.success) {
      log.error({ error: result.error }, "Failed to post Discord move message");
    }
  } catch (error) {
    log.error({ err: error }, "Discord notifyCardMoved failed");
  }
};
