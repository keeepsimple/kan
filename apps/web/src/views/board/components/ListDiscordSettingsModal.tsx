import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

type Behaviour = "create_thread" | "notify" | null;

interface QueryParams {
  boardPublicId: string;
  members: string[];
  labels: string[];
  lists: string[];
}

interface ListDiscordSettingsModalProps {
  listPublicId: string;
  currentBehaviour: string | null;
  currentRoleIds: string[];
  queryParams: QueryParams;
}

export default function ListDiscordSettingsModal({
  listPublicId,
  currentBehaviour,
  currentRoleIds,
  queryParams,
}: ListDiscordSettingsModalProps) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const utils = api.useUtils();

  const [behaviour, setBehaviour] = useState<Behaviour>(
    currentBehaviour === "create_thread" || currentBehaviour === "notify"
      ? currentBehaviour
      : null,
  );
  const [roleIds, setRoleIds] = useState<string[]>(currentRoleIds);

  const { data: discordStatus } = api.discord.getStatus.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const { data: roles } = api.discord.listRoles.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId && !!discordStatus?.connected },
  );

  const updateList = api.list.update.useMutation({
    onSuccess: () => {
      void utils.board.byId.invalidate(queryParams);
      showPopup({
        header: t`List updated`,
        message: t`Discord settings updated.`,
        icon: "success",
      });
      closeModal();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to update list`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const options: { value: Behaviour; label: string; hint: string }[] = [
    { value: null, label: t`None`, hint: t`No Discord activity` },
    {
      value: "create_thread",
      label: t`Create thread`,
      hint: t`Creating a card here creates a Discord thread`,
    },
    {
      value: "notify",
      label: t`Send message`,
      hint: t`Cards cannot be created here; moving a card here posts to its thread`,
    },
  ];

  const toggleRole = (roleId: string) => {
    setRoleIds((current) =>
      current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId],
    );
  };

  return (
    <div className="p-5">
      <div className="flex w-full items-center justify-between pb-4">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Discord settings`}
        </h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      <fieldset className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.label}
            className="flex cursor-pointer items-start gap-2"
          >
            <input
              type="radio"
              name="discord-behaviour"
              checked={behaviour === option.value}
              onChange={() => setBehaviour(option.value)}
              className="mt-[2px]"
            />
            <span className="text-sm text-neutral-900 dark:text-dark-1000">
              {option.label}
              <span className="block text-xs text-neutral-600 dark:text-dark-800">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {behaviour === "create_thread" && (
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-neutral-700 dark:text-dark-900">
            {t`Tag roles in new threads`}
          </label>
          <CheckboxDropdown
            items={(roles ?? []).map((role) => ({
              key: role.id,
              value: role.name,
              selected: roleIds.includes(role.id),
            }))}
            handleSelect={(_groupKey, item) => toggleRole(item.key)}
          >
            <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
              {roleIds.length
                ? (roles ?? [])
                    .filter((role) => roleIds.includes(role.id))
                    .map((role) => role.name)
                    .join(", ")
                : t`No roles`}
            </div>
          </CheckboxDropdown>
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button
          isLoading={updateList.isPending}
          onClick={() =>
            updateList.mutate({
              listPublicId,
              discordBehaviour: behaviour,
              discordRoleIds: behaviour === "create_thread" ? roleIds : [],
            })
          }
        >
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
