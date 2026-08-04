import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { HiOutlineBell, HiOutlineBellSlash } from "react-icons/hi2";

import Button from "~/components/Button";
import { Tooltip } from "~/components/Tooltip";
import { NOTIFY_PREF_EVENT } from "~/hooks/useBoardNotifications";
import { readNotifyPref, writeNotifyPref } from "~/utils/boardNotifier";

/**
 * One switch for sound, tab badge and desktop popup. Sound and badge need no
 * browser permission, so a denied permission does not disable the toggle —
 * only the desktop popup is skipped.
 */
export default function BoardNotificationToggle() {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");

  useEffect(() => {
    setEnabled(readNotifyPref());
    setPermission(
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    );
  }, []);

  const toggle = async () => {
    const next = !enabled;

    // Browsers require requestPermission() to run inside a user gesture, so
    // this must stay in the click handler. Turning on succeeds either way —
    // sound and badge work without permission.
    if (
      next &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      try {
        setPermission(await Notification.requestPermission());
      } catch {
        setPermission("denied");
      }
    }

    setEnabled(next);
    writeNotifyPref(next);
    window.dispatchEvent(new CustomEvent(NOTIFY_PREF_EVENT));
  };

  const label = !enabled
    ? t`Turn on board change notifications`
    : permission === "denied"
      ? t`Desktop notifications are blocked by your browser — sound and tab badge still work.`
      : permission === "unsupported"
        ? t`This browser doesn't support desktop notifications — sound and tab badge still work.`
        : t`Turn off board change notifications`;

  return (
    <Tooltip content={label}>
      <Button
        variant="secondary"
        iconOnly
        iconLeft={
          enabled ? (
            <HiOutlineBell className="h-5 w-5" aria-hidden="true" />
          ) : (
            <HiOutlineBellSlash className="h-5 w-5" aria-hidden="true" />
          )
        }
        onClick={() => void toggle()}
        aria-label={label}
        aria-pressed={enabled}
      />
    </Tooltip>
  );
}
