import { eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { boards, cards, workspaceDiscord } from "@kan/db/schema";

export const getByWorkspaceId = (db: dbClient, workspaceId: number) => {
  return db.query.workspaceDiscord.findFirst({
    where: eq(workspaceDiscord.workspaceId, workspaceId),
  });
};

export const create = async (
  db: dbClient,
  input: {
    workspaceId: number;
    guildId: string;
    guildName: string | null;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(workspaceDiscord)
    .values(input)
    .onConflictDoUpdate({
      target: workspaceDiscord.workspaceId,
      set: { guildId: input.guildId, guildName: input.guildName },
    })
    .returning();

  return result;
};

export const deleteByWorkspaceId = async (
  db: dbClient,
  workspaceId: number,
) => {
  await db
    .delete(workspaceDiscord)
    .where(eq(workspaceDiscord.workspaceId, workspaceId));
};

export const setCardDiscordThreadId = async (
  db: dbClient,
  cardId: number,
  threadId: string,
) => {
  await db
    .update(cards)
    .set({ discordThreadId: threadId })
    .where(eq(cards.id, cardId));
};

export const setCardDiscordMessageId = async (
  db: dbClient,
  cardId: number,
  messageId: string,
) => {
  await db
    .update(cards)
    .set({ discordMessageId: messageId })
    .where(eq(cards.id, cardId));
};

export const getBoardDiscordChannelId = async (
  db: dbClient,
  boardId: number,
) => {
  const board = await db.query.boards.findFirst({
    columns: { discordChannelId: true },
    where: eq(boards.id, boardId),
  });

  return board?.discordChannelId ?? null;
};
