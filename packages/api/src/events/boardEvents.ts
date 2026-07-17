import { EventEmitter } from "events";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";

export interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
}

// Singleton on globalThis so Next.js dev hot-reload (and any duplicate
// module instances across the tRPC handler / SSE route bundles) share one
// emitter — the standard hot-reload-safe singleton pattern.
const store = globalThis as unknown as { __kanBoardEvents?: EventEmitter };

function getEmitter(): EventEmitter {
  if (!store.__kanBoardEvents) {
    const emitter = new EventEmitter();
    // One listener per open SSE connection; the default cap of 10 would
    // log warnings with 11+ viewers on a board.
    emitter.setMaxListeners(0);
    store.__kanBoardEvents = emitter;
  }
  return store.__kanBoardEvents;
}

export function emitBoardEvent(event: BoardEvent): void {
  getEmitter().emit(`board:${event.boardPublicId}`, event);
}

export function subscribeToBoard(
  boardPublicId: string,
  listener: (event: BoardEvent) => void,
): () => void {
  const emitter = getEmitter();
  const channel = `board:${boardPublicId}`;
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}

// Fire-and-forget: realtime is best-effort and must never fail a mutation.
function emitResolved(
  resolve: Promise<string | undefined>,
  cardPublicId?: string,
): void {
  resolve
    .then((boardPublicId) => {
      if (boardPublicId)
        emitBoardEvent({
          boardPublicId,
          ...(cardPublicId ? { cardPublicId } : {}),
        });
    })
    .catch(() => undefined);
}

export function emitFromCard(db: dbClient, cardPublicId: string): void {
  emitResolved(
    cardRepo.getBoardPublicIdByCardPublicId(db, cardPublicId),
    cardPublicId,
  );
}

export function emitFromList(db: dbClient, listPublicId: string): void {
  emitResolved(listRepo.getBoardPublicIdByListPublicId(db, listPublicId));
}

export function emitFromLabel(db: dbClient, labelPublicId: string): void {
  emitResolved(labelRepo.getBoardPublicIdByLabelPublicId(db, labelPublicId));
}
