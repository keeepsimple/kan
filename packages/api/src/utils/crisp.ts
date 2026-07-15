import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import { createLogger } from "@kan/logger";

import { createCardWebhookPayload, sendWebhooksForWorkspace } from "./webhook";

const log = createLogger("crisp");

export const CARD_COMMAND_PREFIX = "#card";

const MAX_TITLE_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 10000;

export function parseCardCommand(
  content: string,
): { title: string; body: string } | null {
  const trimmed = content.trim();

  if (!trimmed.startsWith(`${CARD_COMMAND_PREFIX} `)) return null;

  const rest = trimmed.slice(CARD_COMMAND_PREFIX.length + 1).trim();
  if (!rest) return null;

  const [firstLine = "", ...bodyLines] = rest.split("\n");
  const title = firstLine.trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  return { title, body: bodyLines.join("\n").trim() };
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

  // Target list was soft-deleted; don't create cards into a hidden list.
  if (integration.list.deletedAt) return { status: 200, message: "Ignored" };

  const description = buildCardDescription({
    body: command.body,
    websiteId: data.website_id,
    sessionId: data.session_id,
    operatorNickname: data.user?.nickname,
  });

  try {
    const newCard = await cardRepo.create(db, {
      title: command.title,
      description,
      createdBy: integration.createdBy,
      listId: integration.listId,
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
          title: command.title,
          description,
          dueDate: null,
          listId: integration.list.publicId,
        },
        {
          boardId: integration.list.board.publicId,
          boardName: integration.list.board.name,
          listName: integration.list.name,
        },
      ),
    ).catch((error) => {
      log.error({ err: error }, "Crisp card webhook fanout failed");
    });

    return { status: 200, message: "Card created" };
  } catch (error) {
    log.error({ err: error }, "Failed to create card from Crisp note");
    return { status: 500, message: "Internal error" };
  }
}
