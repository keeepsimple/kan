import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

interface BoardDiscordChannelModalProps {
  boardPublicId: string;
  currentChannelId: string | null;
}

export default function BoardDiscordChannelModal({
  boardPublicId,
  currentChannelId,
}: BoardDiscordChannelModalProps) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const utils = api.useUtils();
  const [channelId, setChannelId] = useState<string | null>(currentChannelId);

  const { data: channels } = api.discord.listChannels.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const updateBoard = api.board.update.useMutation({
    onSuccess: () => {
      void utils.board.byId.invalidate();
      showPopup({
        header: t`Board updated`,
        message: t`Discord channel updated.`,
        icon: "success",
      });
      closeModal();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to update board`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const items = [
    { key: "", value: t`No channel`, selected: !channelId },
    ...(channels ?? []).map((channel) => ({
      key: channel.id,
      value: `#${channel.name}`,
      selected: channel.id === channelId,
    })),
  ];

  return (
    <div className="p-5">
      <div className="flex w-full items-center justify-between pb-4">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Discord channel`}
        </h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      <p className="mb-3 text-xs text-neutral-700 dark:text-dark-900">
        {t`Card threads for this board are created in the selected channel.`}
      </p>
      <CheckboxDropdown
        items={items}
        handleSelect={(_groupKey, item) => setChannelId(item.key || null)}
      >
        <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
          {items.find((item) => item.selected)?.value}
        </div>
      </CheckboxDropdown>
      <div className="mt-6 flex justify-end">
        <Button
          isLoading={updateBoard.isPending}
          onClick={() =>
            updateBoard.mutate({ boardPublicId, discordChannelId: channelId })
          }
        >
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
