import { timingSafeEqual } from "crypto";

import type { NextApiRequest, NextApiResponse } from "next";

import { createDrizzleClient } from "@kan/db/client";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardRepo from "@kan/db/repository/card.repo";

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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // Vercel Cron issues GET requests (with an auto-attached bearer header when
  // CRON_SECRET is set); self-host schedulers typically use POST. Both are
  // accepted here and bearer-guarded identically below.
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

  const stale = await cardRepo.getStaleCompletedCards(db);
  const now = new Date();
  let archived = 0;

  for (const card of stale) {
    await cardRepo.softDelete(db, {
      cardId: card.id,
      deletedAt: now,
      deletedBy: null,
    });
    await cardActivityRepo.create(db, {
      type: "card.archived",
      cardId: card.id,
      createdBy: null,
    });
    archived += 1;
  }

  return res.status(200).json({ archived });
}
