export const NOTIFY_STORAGE_KEY = "kan:board-notify";

/** Floor between two chimes so a busy board cannot ring continuously. */
export const THROTTLE_MS = 5000;

export interface BoardNotifierDeps {
  now: () => number;
  isHidden: () => boolean;
  isEnabled: () => boolean;
  permission: () => NotificationPermission | "unsupported";
  playSound: () => void;
  showDesktop: (args: { title: string; body: string; tag: string }) => void;
  onUnreadChange: (unread: number) => void;
}

export interface BoardNotifier {
  notify(args: {
    boardPublicId: string;
    boardName: string;
    body: string;
  }): void;
  reset(): void;
}

/**
 * Decides what a board change should do to the browser: chime, bump the tab
 * badge, raise a desktop notification. Every browser API is injected so this
 * stays testable without a DOM.
 */
export function createBoardNotifier(deps: BoardNotifierDeps): BoardNotifier {
  let lastNotifiedAt = -Infinity;
  let unread = 0;

  return {
    notify({ boardPublicId, boardName, body }) {
      if (!deps.isEnabled()) return;

      const at = deps.now();
      if (at - lastNotifiedAt < THROTTLE_MS) return;
      lastNotifiedAt = at;

      deps.playSound();

      // The badge and the popup only make sense when the user isn't looking.
      if (!deps.isHidden()) return;

      unread += 1;
      deps.onUnreadChange(unread);

      if (deps.permission() === "granted")
        deps.showDesktop({
          title: boardName,
          body,
          // One live notification per board: a new one replaces the old.
          tag: `kan-board-${boardPublicId}`,
        });
    },

    reset() {
      if (unread === 0) return;
      unread = 0;
      deps.onUnreadChange(0);
    },
  };
}

export function readNotifyPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(NOTIFY_STORAGE_KEY) === "true";
  } catch {
    // Safari private mode and blocked-storage settings throw on access.
    return false;
  }
}

export function writeNotifyPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, String(enabled));
  } catch {
    // Preference simply does not persist; the in-memory state still applies.
  }
}
