import { timingSafeEqual } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";

import type { dbClient } from "@kan/db/client";
import { createDrizzleClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import { postMessage } from "@kan/discord";

const db = createDrizzleClient();

function validSecret(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Posts due reminders (10 minutes before + at due time) into card threads. */
export async function sendDueReminders(client: dbClient): Promise<number> {
  let reminded = 0;

  const soon = await cardRepo.getCardsNeedingDueSoonReminder(client);
  for (const card of soon) {
    if (!card.discordThreadId || !card.dueDate) continue;
    const unix = Math.floor(card.dueDate.getTime() / 1000);
    const result = await postMessage(
      card.discordThreadId,
      "",
      [],
      [
        {
          color: 0xf59e0b, // amber
          title: "⏰ Due soon",
          description: `**${card.title}** — <t:${unix}:R> (<t:${unix}:f>)`,
        },
      ],
    );
    // Only mark as sent when Discord accepted it, so failures retry next run
    if (result.success) {
      await cardRepo.markDueReminderSent(client, card.id);
      reminded += 1;
    }
  }

  const arrived = await cardRepo.getCardsNeedingDueNowReminder(client);
  for (const card of arrived) {
    if (!card.discordThreadId || !card.dueDate) continue;
    const unix = Math.floor(card.dueDate.getTime() / 1000);
    const result = await postMessage(
      card.discordThreadId,
      "",
      [],
      [
        {
          color: 0xdc2626, // red
          title: "🔔 Due now",
          description: `**${card.title}** — <t:${unix}:f>`,
        },
      ],
    );
    if (result.success) {
      await cardRepo.markDueArrivedReminderSent(client, card.id);
      reminded += 1;
    }
  }

  return reminded;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ message: "CRON_SECRET not configured" });
  }

  if (!validSecret(req.headers.authorization)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const reminded = await sendDueReminders(db);

  return res.status(200).json({ reminded });
}
