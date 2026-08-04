import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@lingui/core/macro";

import type { BoardNotifier } from "~/utils/boardNotifier";
import { createBoardNotifier, readNotifyPref } from "~/utils/boardNotifier";

export const NOTIFY_PREF_EVENT = "kan:board-notify-changed";

const SOUND_URL = "/sounds/notification.mp3";
const SOUND_VOLUME = 0.4;

/**
 * Turns board changes into a chime, a tab badge count, and a desktop
 * notification. The badge count is returned rather than written to
 * document.title, because PageHead owns the title through next/head.
 */
export function useBoardNotifications({
  boardPublicId,
  boardName,
}: {
  boardPublicId?: string | null;
  boardName?: string | null;
}): { unreadCount: number; notify: () => void } {
  const [unreadCount, setUnreadCount] = useState(0);
  const [enabled, setEnabled] = useState(false);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;

  // localStorage is not readable during SSR; read it after mount, and follow
  // the toggle in the board header while mounted.
  useEffect(() => {
    setEnabled(readNotifyPref());
    const sync = () => setEnabled(readNotifyPref());
    window.addEventListener(NOTIFY_PREF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NOTIFY_PREF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const notifier: BoardNotifier = useMemo(
    () =>
      createBoardNotifier({
        now: () => performance.now(),
        isHidden: () => document.hidden,
        isEnabled: () => enabledRef.current,
        permission: () =>
          typeof Notification === "undefined"
            ? "unsupported"
            : Notification.permission,
        playSound: () => {
          const audio = new Audio(SOUND_URL);
          audio.volume = SOUND_VOLUME;
          // Autoplay policies reject until the user has interacted with the
          // page; a silent notification is fine, a crash is not.
          void audio.play().catch(() => undefined);
        },
        showDesktop: ({ title, body, tag }) => {
          const notification = new Notification(title, {
            body,
            tag,
            icon: "/icon-512.png",
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        },
        onUnreadChange: setUnreadCount,
      }),
    [],
  );

  // Clear the badge as soon as the user comes back to the tab.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) notifier.reset();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [notifier]);

  // A different board means a different badge.
  useEffect(() => {
    notifier.reset();
  }, [boardPublicId, notifier]);

  const notify = useCallback(() => {
    if (!boardPublicId) return;
    notifier.notify({
      boardPublicId,
      boardName: boardNameRef.current ?? t`Kan`,
      body: t`This board has new changes`,
    });
  }, [boardPublicId, notifier]);

  return { unreadCount, notify };
}
