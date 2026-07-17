import { EventEmitter } from "events";

export interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
}

// Singleton on globalThis so Next.js dev hot-reload can't split emitters
// across module instances (same pattern as a typical db-client singleton).
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
