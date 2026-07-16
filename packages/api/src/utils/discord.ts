import { TRPCError } from "@trpc/server";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";
import { createLogger } from "@kan/logger";

const log = createLogger("discord");

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Converts editor HTML to Discord markdown so the embed mirrors the card. */
export const htmlToDiscordMarkdown = (html: string): string =>
  decodeEntities(
    html
      // Embeds don't render "#" headings — bold on its own line instead
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gis, "**$1**\n")
      .replace(/<li[^>]*>(.*?)<\/li>/gis, "• $1\n")
      .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gis, "**$2**")
      .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gis, "*$2*")
      .replace(/<code[^>]*>(.*?)<\/code>/gis, "`$1`")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const cardUrl = (cardPublicId: string): string | undefined => {
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  return base ? `${base}/cards/${cardPublicId}` : undefined;
};

interface CardEmbedArgs {
  cardTitle: string;
  cardPublicId?: string | null;
  description?: string | null;
  listName?: string | null;
  labelNames?: string[];
  labelColour?: string | null;
  memberNames?: string[];
  dueDate?: Date | null;
  checklists?: { name: string; items: string[] }[];
  createdBy?: string | null;
}

export const buildCardEmbed = (
  args: CardEmbedArgs,
): discordClient.DiscordEmbed => {
  // Card descriptions are editor HTML — mirror them as Discord markdown
  const description = args.description
    ? htmlToDiscordMarkdown(args.description)
    : undefined;

  const fields: NonNullable<discordClient.DiscordEmbed["fields"]> = [];
  if (args.createdBy)
    fields.push({
      name: "✨ Created by",
      value: `**${args.createdBy}**`,
      inline: true,
    });
  if (args.listName)
    fields.push({ name: "📂 List", value: args.listName, inline: true });
  if (args.labelNames?.length)
    fields.push({
      name: "🏷️ Labels",
      value: args.labelNames.join(", "),
      inline: true,
    });
  if (args.dueDate)
    // Discord renders <t:unix:f> as a localized timestamp
    fields.push({
      name: "⏰ Due",
      value: `<t:${Math.floor(args.dueDate.getTime() / 1000)}:f>`,
      inline: true,
    });
  for (const checklist of args.checklists ?? []) {
    // Discord embed limits: field name 256, value 1024 chars
    fields.push({
      name: `✅ ${checklist.name}`.slice(0, 256),
      value:
        checklist.items
          .map((item) => `• ${item}`)
          .join("\n")
          .slice(0, 1024) || "—",
    });
  }
  if (args.memberNames?.length)
    fields.push({ name: "👥 Members", value: args.memberNames.join(", ") });

  // Embed strip takes the first label's colour (hex like #dc2626)
  const colourHex = /^#([0-9a-f]{6})$/i.exec(args.labelColour ?? "")?.[1];

  const url = args.cardPublicId ? cardUrl(args.cardPublicId) : undefined;

  return {
    ...(colourHex ? { color: parseInt(colourHex, 16) } : {}),
    // Discord caps embed titles at 256 chars
    title: `📌 ${args.cardTitle}`.slice(0, 256),
    ...(url ? { url } : {}),
    ...(description ? { description: description.slice(0, 2000) } : {}),
    // Discord caps embeds at 25 fields
    ...(fields.length ? { fields: fields.slice(0, 25) } : {}),
  };
};

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
    cardPublicId?: string | null;
    cardTitle: string;
    boardName: string;
    workspaceId: number;
    discordChannelId: string | null;
    discordBehaviour: string | null;
    discordRoleIds: string | null;
    description?: string | null;
    listName?: string | null;
    labelNames?: string[];
    labelColour?: string | null;
    memberNames?: string[];
    dueDate?: Date | null;
    checklists?: { name: string; items: string[] }[];
    createdBy?: string | null;
  },
): Promise<void> => {
  try {
    if (args.discordBehaviour !== "create_thread" || !args.discordChannelId)
      return;

    const connection = await discordRepo.getByWorkspaceId(db, args.workspaceId);
    if (!connection) return;

    const thread = await discordClient.createThread(
      args.discordChannelId,
      `${args.cardTitle} - 📋 ${args.boardName}`,
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
    const embed = buildCardEmbed(args);

    const message = await discordClient.postMessage(
      thread.data.id,
      mentions,
      roleIds,
      [embed],
    );
    if (!message.success || !message.data) {
      log.error(
        { error: message.error, cardId: args.cardId },
        "Failed to post Discord thread message",
      );
      return;
    }

    // Remember the message so later card edits can update the embed in place
    await discordRepo.setCardDiscordMessageId(db, args.cardId, message.data.id);
  } catch (error) {
    log.error(
      { err: error, cardId: args.cardId },
      "Discord notifyCardCreated failed",
    );
  }
};

/** Re-renders the thread's first embed from the card's current state. */
export const notifyCardUpdated = async (
  db: dbClient,
  cardPublicId: string,
): Promise<void> => {
  try {
    const card = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!card?.discordThreadId || !card.discordMessageId) return;

    const embed = buildCardEmbed({
      cardTitle: card.title,
      cardPublicId,
      description: card.description,
      listName: card.list.name,
      labelNames: card.labels.map((l) => l.label.name),
      labelColour: card.labels[0]?.label.colourCode ?? null,
      memberNames: card.members.map(
        (m) => m.member.user?.name ?? m.member.email,
      ),
      dueDate: card.dueDate,
      checklists: card.checklists.map((checklist) => ({
        name: checklist.name,
        items: checklist.items.map((item) => item.title),
      })),
      createdBy: card.createdBy?.name ?? null,
    });

    const result = await discordClient.editMessage(
      card.discordThreadId,
      card.discordMessageId,
      [embed],
    );
    if (!result.success) {
      log.error(
        { error: result.error, cardPublicId },
        "Failed to edit Discord thread message",
      );
    }
  } catch (error) {
    log.error({ err: error, cardPublicId }, "Discord notifyCardUpdated failed");
  }
};

export const notifyCardMoved = async (
  db: dbClient,
  args: {
    cardTitle: string;
    newListName: string;
    userName: string | null;
    workspaceId: number;
    newListDiscordBehaviour: string | null | undefined;
    cardDiscordThreadId: string | null | undefined;
    newListBoardId: number;
  },
): Promise<void> => {
  try {
    if (args.newListDiscordBehaviour !== "notify") return;

    const connection = await discordRepo.getByWorkspaceId(db, args.workspaceId);
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

    const embed: discordClient.DiscordEmbed = {
      color: 0xadd8e6, // light blue
      title: `📌 ${args.cardTitle}`.slice(0, 256),
      description: `📊 Status: ${args.newListName}\n👤 Moved by: **${args.userName ?? "unknown"}**`,
    };

    const result = await discordClient.postMessage(targetId, "", [], [embed]);
    if (!result.success) {
      log.error({ error: result.error }, "Failed to post Discord move message");
    }
  } catch (error) {
    log.error({ err: error }, "Discord notifyCardMoved failed");
  }
};
