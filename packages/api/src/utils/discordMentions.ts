import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import { buildUserMentions, postMessage } from "@kan/discord";
import { parseMentionsFromHTML } from "@kan/shared/utils";

async function resolveDiscordIds(
  db: dbClient,
  memberPublicIds: string[],
  workspaceId?: number,
): Promise<string[]> {
  if (!memberPublicIds.length) return [];
  const members = await memberRepo.getByPublicIdsWithUsers(
    db,
    memberPublicIds,
    workspaceId,
  );
  return members
    .map((m) => m.user?.discordUserId ?? null)
    .filter((id): id is string => !!id);
}

export async function notifyAssigned(
  db: dbClient,
  cardPublicId: string,
  memberPublicIds: string[],
): Promise<void> {
  try {
    const ctx = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!ctx?.discordThreadId) return;
    const ids = await resolveDiscordIds(
      db,
      memberPublicIds,
      ctx.list.board.workspaceId,
    );
    if (!ids.length) return;
    await postMessage(
      ctx.discordThreadId,
      `${buildUserMentions(ids)} you were assigned to this card.`,
      [],
      [],
      ids,
    );
  } catch (error) {
    console.error("Discord assignment ping failed:", error);
  }
}

export async function notifyCommentMentions(
  db: dbClient,
  cardPublicId: string,
  commentHtml: string,
  authorName: string,
): Promise<void> {
  try {
    const memberPublicIds = parseMentionsFromHTML(commentHtml);
    if (!memberPublicIds.length) return;
    const ctx = await cardRepo.getDiscordContextByPublicId(db, cardPublicId);
    if (!ctx?.discordThreadId) return;
    const ids = await resolveDiscordIds(
      db,
      memberPublicIds,
      ctx.list.board.workspaceId,
    );
    if (!ids.length) return;
    await postMessage(
      ctx.discordThreadId,
      `${buildUserMentions(ids)} — mentioned by ${authorName}`,
      [],
      [],
      ids,
    );
  } catch (error) {
    console.error("Discord comment mention ping failed:", error);
  }
}
