import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import { createLogger } from "@kan/logger";

import { emitFromList } from "../events/boardEvents";
import { notifyCardCreated } from "./discord";
import { createCardWebhookPayload, sendWebhooksForWorkspace } from "./webhook";

const log = createLogger("crisp");

export const CARD_COMMAND_PREFIX = "!create-sp";

/** A leading `#board-slug` token selects the target board. */
const BOARD_SLUG_RE = /^#([a-z0-9-]{1,255})$/i;

const MAX_TITLE_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 10000;

export interface ParsedCardCommand {
  boardSlug: string | null;
  title: string;
  /** First line verbatim, `#slug` token included — used when the slug
   *  does not resolve, so no typed words are silently dropped. */
  rawTitle: string;
  body: string;
}

export function parseCardCommand(content: string): ParsedCardCommand | null {
  const trimmed = content.trim();

  if (!trimmed.startsWith(`${CARD_COMMAND_PREFIX} `)) return null;

  const rest = trimmed.slice(CARD_COMMAND_PREFIX.length + 1).trim();
  if (!rest) return null;

  const [firstLineRaw = "", ...bodyLines] = rest.split("\n");
  const firstLine = firstLineRaw.trim();
  const body = bodyLines.join("\n").trim();

  const rawTitle = firstLine.slice(0, MAX_TITLE_LENGTH);
  if (!rawTitle) return null;

  const [firstToken = ""] = firstLine.split(/\s+/);
  const slug = BOARD_SLUG_RE.exec(firstToken)?.[1];

  if (slug) {
    // slice, not split/join — keeps the title's internal spacing intact
    const title = firstLine.slice(firstToken.length).trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) return null;
    return { boardSlug: slug.toLowerCase(), title, rawTitle, body };
  }

  return { boardSlug: null, title: rawTitle, rawTitle, body };
}

export function buildCardDescription(input: {
  body: string;
  websiteId: string;
  sessionId: string;
  operatorNickname?: string;
}): string {
  const conversationUrl = `https://app.crisp.chat/website/${input.websiteId}/inbox/${input.sessionId}/`;

  const lines: string[] = [];
  if (input.body) lines.push(input.body, "");
  lines.push("---");
  lines.push(`Created from a [Crisp conversation](${conversationUrl})`);
  if (input.operatorNickname)
    lines.push(`Operator: ${input.operatorNickname}`);

  return lines.join("\n").slice(0, MAX_DESCRIPTION_LENGTH);
}

const crispEventSchema = z.object({
  event: z.string(),
  data: z
    .object({
      website_id: z.string(),
      session_id: z.string(),
      type: z.string().optional(),
      from: z.string().optional(),
      content: z.unknown().optional(),
      user: z.object({ nickname: z.string().optional() }).optional(),
    })
    .passthrough(),
});

export async function handleCrispWebhook(
  db: dbClient,
  token: string,
  body: unknown,
): Promise<{ status: 200 | 404 | 500; message: string }> {
  const integration = await crispIntegrationRepo.getActiveBySecret(db, token);
  if (!integration) return { status: 404, message: "Not found" };

  const parsed = crispEventSchema.safeParse(body);
  if (!parsed.success) return { status: 200, message: "Ignored" };

  const { event, data } = parsed.data;

  if (
    event !== "message:received" ||
    data.type !== "note" ||
    data.from !== "operator" ||
    data.website_id !== integration.crispWebsiteId ||
    typeof data.content !== "string"
  )
    return { status: 200, message: "Ignored" };

  const command = parseCardCommand(data.content);
  if (!command) return { status: 200, message: "Ignored" };

  let resolvedBySlug = false;
  let target = null as Awaited<
    ReturnType<typeof listRepo.getWorkspaceAndListIdByListPublicId>
  >;

  if (command.boardSlug) {
    target = await listRepo.getFirstListByBoardSlug(db, {
      boardSlug: command.boardSlug,
      workspaceId: integration.workspaceId,
    });
    resolvedBySlug = target !== null;
  }

  // Also covers a soft-deleted default list: the repo filters deletedAt.
  target ??= await listRepo.getWorkspaceAndListIdByListPublicId(
    db,
    integration.list.publicId,
  );

  if (!target) return { status: 200, message: "Ignored" };

  // Mirrors assertListAllowsCardCreation, which the card router enforces for
  // every other creation path. A webhook must not throw, so log and 200.
  if (target.discordBehaviour === "notify") {
    log.warn(
      { listPublicId: target.publicId },
      "Crisp note targeted a Discord notify list — skipped",
    );
    return { status: 200, message: "Ignored" };
  }

  // Slug did not resolve: keep the #slug token in the title so no typed
  // words are silently dropped.
  const title = resolvedBySlug ? command.title : command.rawTitle;

  const description = buildCardDescription({
    body: command.body,
    websiteId: data.website_id,
    sessionId: data.session_id,
    operatorNickname: data.user?.nickname,
  });

  try {
    const newCard = await cardRepo.create(db, {
      title,
      description,
      createdBy: integration.createdBy,
      listId: target.id,
      workspaceId: integration.workspaceId,
      position: "end",
    });

    if (!newCard.id) return { status: 500, message: "Failed to create card" };

    // Fire outbound workspace webhooks (non-blocking), same as the card router
    sendWebhooksForWorkspace(
      db,
      integration.workspaceId,
      createCardWebhookPayload(
        "card.created",
        {
          id: String(newCard.id),
          publicId: newCard.publicId,
          title,
          description,
          dueDate: null,
          listId: target.publicId,
        },
        {
          boardId: target.boardPublicId,
          boardName: target.boardName,
          listName: target.name,
        },
      ),
    ).catch((error) => {
      log.error({ err: error }, "Crisp card webhook fanout failed");
    });

    // Same Discord path as the card router: forum channels get a forum post,
    // text channels get a thread.
    notifyCardCreated(db, {
      cardId: newCard.id,
      cardPublicId: newCard.publicId,
      cardTitle: title,
      boardName: target.boardName,
      workspaceId: integration.workspaceId,
      discordChannelId: target.boardDiscordChannelId,
      discordBehaviour: target.discordBehaviour,
      discordRoleIds: target.discordRoleIds,
      description,
      listName: target.name,
      createdBy: data.user?.nickname ?? null,
    }).catch((error) => {
      log.error({ err: error }, "Crisp Discord notify failed");
    });

    // No acting viewer — an integration created this, so notify everyone.
    emitFromList(db, target.publicId, null);

    return { status: 200, message: "Card created" };
  } catch (error) {
    log.error({ err: error }, "Failed to create card from Crisp note");
    return { status: 500, message: "Internal error" };
  }
}
