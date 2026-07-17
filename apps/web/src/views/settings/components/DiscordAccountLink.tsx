import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { authClient } from "@kan/auth/client";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

const DISCORD_USER_ID_REGEX = /^\d{15,20}$/;
const SETTINGS_CALLBACK_URL = "/settings/account";

const DiscordAccountLink = () => {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const { data: user } = api.user.getUser.useQuery();
  const { data: socialProviders } = useQuery({
    queryKey: ["socialProviders"],
    queryFn: () => authClient.getSocialProviders(),
  });
  const [discordUserId, setDiscordUserId] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  // Only offer the OAuth connect flow when Discord is actually configured as a
  // social provider; otherwise only the paste-ID fallback is shown.
  const discordOAuthEnabled = socialProviders?.includes("discord") ?? false;

  const linkDiscord = api.user.linkDiscord.useMutation({
    onSuccess: async () => {
      showPopup({
        header: t`Discord linked`,
        message: t`Your Discord account has been linked.`,
        icon: "success",
      });
      setDiscordUserId("");
      try {
        await utils.user.getUser.refetch();
      } catch (e) {
        console.error(e);
        throw e;
      }
    },
    onError: () => {
      showPopup({
        header: t`Error linking Discord`,
        message: t`Please check the Discord user ID and try again.`,
        icon: "error",
      });
    },
  });

  const unlinkDiscord = api.user.unlinkDiscord.useMutation({
    onSuccess: async () => {
      showPopup({
        header: t`Discord unlinked`,
        message: t`Your Discord account has been unlinked.`,
        icon: "success",
      });
      try {
        await utils.user.getUser.refetch();
      } catch (e) {
        console.error(e);
        throw e;
      }
    },
    onError: () => {
      showPopup({
        header: t`Error unlinking Discord`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
    },
  });

  // Connect via Discord OAuth (links the account to the current user). Better
  // Auth redirects the browser to Discord and back to SETTINGS_CALLBACK_URL;
  // the account-create hook then populates the Discord mapping server-side.
  const handleConnect = async () => {
    setIsConnecting(true);
    const notifyError = () => {
      showPopup({
        header: t`Error connecting Discord`,
        message: t`Please try again later, or contact customer support.`,
        icon: "error",
      });
      setIsConnecting(false);
    };
    try {
      // Better Auth's client resolves with `{ error }` on API errors (it does
      // not throw); on success the browser redirects, so we only handle errors.
      const { error } = await authClient.linkSocial({
        provider: "discord",
        callbackURL: SETTINGS_CALLBACK_URL,
      });
      if (error) notifyError();
    } catch (e) {
      console.error(e);
      notifyError();
    }
  };

  // Clear the tagging mapping, and best-effort remove the OAuth account link so
  // a later reconnect re-creates it and repopulates the mapping. Ignore
  // failures (e.g. Discord is the only login method, or the mapping came from a
  // manually pasted ID with no linked OAuth account).
  const handleUnlink = async () => {
    try {
      await authClient.unlinkAccount({ providerId: "discord" });
    } catch (e) {
      console.error(e);
    }
    unlinkDiscord.mutate({});
  };

  const linked = Boolean(user?.discordUserId);
  const isValidDiscordUserId = DISCORD_USER_ID_REGEX.test(discordUserId);

  if (linked) {
    return (
      <div className="flex gap-2">
        <div className="mb-4 flex w-full max-w-[325px] items-center gap-2">
          <p className="text-sm text-neutral-700 dark:text-dark-900">
            {user?.discordUsername ?? user?.discordUserId}
          </p>
        </div>
        <div>
          <Button
            variant="secondary"
            onClick={() => void handleUnlink()}
            disabled={unlinkDiscord.isPending}
            isLoading={unlinkDiscord.isPending}
          >
            {t`Unlink`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {discordOAuthEnabled && (
        <div>
          <Button
            variant="primary"
            onClick={() => void handleConnect()}
            disabled={isConnecting}
            isLoading={isConnecting}
          >
            {t`Connect with Discord`}
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <div className="flex w-full max-w-[325px] items-center gap-2">
          <Input
            value={discordUserId}
            onChange={(e) => setDiscordUserId(e.target.value)}
            placeholder={t`Or paste your Discord user ID`}
          />
        </div>
        <div>
          <Button
            variant="secondary"
            onClick={() => linkDiscord.mutate({ discordUserId })}
            disabled={linkDiscord.isPending || !isValidDiscordUserId}
            isLoading={linkDiscord.isPending}
          >
            {t`Link`}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DiscordAccountLink;
