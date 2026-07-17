import { useEffect, useRef } from "react";

import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
}

const DEBOUNCE_MS = 300;

/**
 * Subscribes to server-sent board events and refetches the affected
 * queries. Events are signals only — data still flows through tRPC.
 * EventSource auto-reconnects; every (re)open triggers one invalidate
 * to cover events missed while disconnected.
 */
export function useBoardEvents(
  boardPublicId?: string | null,
  openCardPublicId?: string | null,
): void {
  const utils = api.useUtils();
  const openCardRef = useRef(openCardPublicId);
  openCardRef.current = openCardPublicId;

  useEffect(() => {
    if (!boardPublicId) return;

    const source = new EventSource(`/api/events/board/${boardPublicId}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cardChanged = false;

    const refresh = () => {
      void utils.board.byId.invalidate();
      if (cardChanged && openCardRef.current) {
        void invalidateCard(utils, openCardRef.current);
      }
      cardChanged = false;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as BoardEvent;
      if (event.cardPublicId && event.cardPublicId === openCardRef.current) {
        cardChanged = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    };

    source.onopen = () => {
      // fires on connect and every auto-reconnect: catch up on missed events
      cardChanged = Boolean(openCardRef.current);
      refresh();
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [boardPublicId, utils]);
}
