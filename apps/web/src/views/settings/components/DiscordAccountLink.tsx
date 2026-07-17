import { t } from "@lingui/core/macro";
import { useState } from "react";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

const DISCORD_USER_ID_REGEX = /^\d{15,20}$/;

const DiscordAccountLink = () => {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const { data: user } = api.user.getUser.useQuery();
  const [discordUserId, setDiscordUserId] = useState("");

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
            onClick={() => unlinkDiscord.mutate({})}
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
    <div className="flex gap-2">
      <div className="mb-4 flex w-full max-w-[325px] items-center gap-2">
        <Input
          value={discordUserId}
          onChange={(e) => setDiscordUserId(e.target.value)}
          placeholder={t`Discord user ID`}
        />
      </div>
      <div>
        <Button
          variant="primary"
          onClick={() => linkDiscord.mutate({ discordUserId })}
          disabled={linkDiscord.isPending || !isValidDiscordUserId}
          isLoading={linkDiscord.isPending}
        >
          {t`Link`}
        </Button>
      </div>
    </div>
  );
};

export default DiscordAccountLink;
