import { useEffect, useRef } from "react";

import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { useBoardNotifications } from "./useBoardNotifications";

interface BoardEventSignal {
  boardPublicId: string;
  cardPublicId?: string;
  /** False when this connection caused the change — refetch, but stay quiet. */
  notify: boolean;
}

const DEBOUNCE_MS = 300;

/**
 * Subscribes to server-sent board events and refetches the affected
 * queries. Events are signals only — data still flows through tRPC.
 * EventSource auto-reconnects; every (re)open triggers one invalidate
 * to cover events missed while disconnected.
 *
 * Returns the number of changes seen while the tab was hidden, for the
 * caller to render as a title badge.
 */
export function useBoardEvents(
  boardPublicId?: string | null,
  openCardPublicId?: string | null,
  boardName?: string | null,
): { unreadCount: number } {
  const utils = api.useUtils();
  const openCardRef = useRef(openCardPublicId);
  openCardRef.current = openCardPublicId;

  const { unreadCount, notify } = useBoardNotifications({
    boardPublicId,
    boardName,
  });
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!boardPublicId) return;

    const source = new EventSource(`/api/events/board/${boardPublicId}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cardChanged = false;
    let shouldNotify = false;

    const refresh = () => {
      void utils.board.byId.invalidate();
      if (cardChanged && openCardRef.current) {
        void invalidateCard(utils, openCardRef.current);
      }
      cardChanged = false;
      // One chime per debounced burst, never for our own edits.
      if (shouldNotify) notifyRef.current();
      shouldNotify = false;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as BoardEventSignal;
      if (event.cardPublicId && event.cardPublicId === openCardRef.current) {
        cardChanged = true;
      }
      if (event.notify) shouldNotify = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    };

    source.onopen = () => {
      // fires on connect and every auto-reconnect: catch up on missed events
      cardChanged = Boolean(openCardRef.current);
      // A reconnect is not a change — never chime for it.
      shouldNotify = false;
      refresh();
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [boardPublicId, utils]);

  return { unreadCount };
}
