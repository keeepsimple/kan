import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import { buildUserMentions, postMessage } from "@kan/discord";

async function resolveDiscordIds(
  db: dbClient,
  memberPublicIds: string[],
): Promise<string[]> {
  if (!memberPublicIds.length) return [];
  const members = await memberRepo.getByPublicIdsWithUsers(db, memberPublicIds);
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
    const ids = await resolveDiscordIds(db, memberPublicIds);
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
