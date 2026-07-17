import type { NextApiRequest, NextApiResponse } from "next";

import { subscribeToBoard } from "@kan/api/events/boardEvents";
import { hasPermission } from "@kan/api/utils/permissions";
import { initAuth } from "@kan/auth/server";
import { createDrizzleClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";

// Long-lived stream: tell Next this route resolves outside the normal cycle.
export const config = { api: { externalResolver: true } };

const HEARTBEAT_MS = 25_000; // under common 30s proxy idle timeouts

const db = createDrizzleClient();
const auth = initAuth(db);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { boardPublicId } = req.query;
  if (typeof boardPublicId !== "string" || boardPublicId.length < 12) {
    return res.status(400).json({ message: "Invalid board id" });
  }

  // Same auth chain as the board.byId tRPC procedure.
  const session = await auth.api.getSession({
    headers: new Headers(req.headers as Record<string, string>),
  });
  if (!session?.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
    db,
    boardPublicId,
  );
  if (!board) {
    return res.status(404).json({ message: "Board not found" });
  }

  const allowed = await hasPermission(
    db,
    session.user.id,
    board.workspaceId,
    "board:view",
  );
  if (!allowed) {
    return res.status(403).json({ message: "Forbidden" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer the stream
  });
  res.write(": connected\n\n");

  const unsubscribe = subscribeToBoard(boardPublicId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
