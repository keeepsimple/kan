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
