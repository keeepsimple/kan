import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiMiniArrowTopRightOnSquare } from "react-icons/hi2";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

export default function DiscordIntegration() {
  const { workspace } = useWorkspace();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [guildId, setGuildId] = useState("");

  const workspacePublicId = workspace.publicId;

  const { data: status } = api.discord.getStatus.useQuery(
    { workspacePublicId },
    { enabled: !!workspacePublicId },
  );

  const connectDiscord = api.discord.connect.useMutation({
    onSuccess: (data) => {
      void utils.discord.getStatus.invalidate({ workspacePublicId });
      setGuildId("");
      showPopup({
        header: t`Discord connected`,
        message: t`Connected to ${data.guildName}.`,
        icon: "success",
      });
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to connect Discord`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const disconnectDiscord = api.discord.disconnect.useMutation({
    onSuccess: () => {
      void utils.discord.getStatus.invalidate({ workspacePublicId });
      showPopup({
        header: t`Discord disconnected`,
        message: t`Your Discord server has been disconnected.`,
        icon: "success",
      });
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to disconnect Discord`,
        message: error.message,
        icon: "error",
      });
    },
  });

  if (!status?.botConfigured) return null;

  return (
    <div className="mb-8 border-t border-light-300 dark:border-dark-300">
      <h2 className="mb-4 mt-8 text-[14px] font-bold text-neutral-900 dark:text-dark-1000">
        {t`Discord`}
      </h2>
      {status.connected ? (
        <div className="mt-4 flex items-center gap-4">
          <p className="text-sm text-neutral-700 dark:text-dark-900">
            {t`Connected to ${status.guildName ?? status.guildId ?? ""}`}
          </p>
          <Button
            variant="secondary"
            isLoading={disconnectDiscord.isPending}
            onClick={() => disconnectDiscord.mutate({ workspacePublicId })}
          >
            {t`Disconnect`}
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-neutral-700 dark:text-dark-900">
            {t`Invite the bot to your Discord server, then paste the server ID below.`}
          </p>
          {status.inviteUrl && (
            <div>
              <Button
                variant="secondary"
                iconRight={<HiMiniArrowTopRightOnSquare />}
                onClick={() =>
                  window.open(status.inviteUrl ?? "", "_blank")
                }
              >
                {t`Invite bot to server`}
              </Button>
            </div>
          )}
          <div className="flex max-w-md items-center gap-2">
            <Input
              id="discord-guild-id"
              placeholder={t`Discord server ID`}
              value={guildId}
              onChange={(e) => setGuildId(e.target.value)}
            />
            <Button
              disabled={!guildId.trim() || connectDiscord.isPending}
              isLoading={connectDiscord.isPending}
              onClick={() =>
                connectDiscord.mutate({
                  workspacePublicId,
                  guildId: guildId.trim(),
                })
              }
            >
              {t`Connect`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
