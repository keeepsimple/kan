import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

interface QueryParams {
  boardPublicId: string;
  members: string[];
  labels: string[];
  lists: string[];
}

interface ListCompletionSettingsModalProps {
  listPublicId: string;
  currentIsCompleted: boolean;
  currentAutoArchiveEnabled: boolean;
  currentAutoArchiveDays: number | null;
  queryParams: QueryParams;
}

export default function ListCompletionSettingsModal({
  listPublicId,
  currentIsCompleted,
  currentAutoArchiveEnabled,
  currentAutoArchiveDays,
  queryParams,
}: ListCompletionSettingsModalProps) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const [isCompleted, setIsCompleted] = useState(currentIsCompleted);
  const [autoArchiveEnabled, setAutoArchiveEnabled] = useState(
    currentAutoArchiveEnabled,
  );
  const [autoArchiveDays, setAutoArchiveDays] = useState(
    currentAutoArchiveDays ?? 3,
  );

  const updateList = api.list.update.useMutation({
    onSuccess: () => {
      void utils.board.byId.invalidate(queryParams);
      showPopup({
        header: t`List updated`,
        message: t`Completion settings updated.`,
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

  const handleSave = () => {
    const clampedDays = Math.min(365, Math.max(1, autoArchiveDays || 1));

    updateList.mutate({
      listPublicId,
      isCompleted,
      autoArchiveEnabled: isCompleted ? autoArchiveEnabled : false,
      autoArchiveDays: isCompleted && autoArchiveEnabled ? clampedDays : null,
    });
  };

  return (
    <div className="p-5">
      <div className="flex w-full items-center justify-between pb-4">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Completion settings`}
        </h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={isCompleted}
          onChange={(e) => setIsCompleted(e.target.checked)}
          className="mt-[2px]"
        />
        <span className="text-sm text-neutral-900 dark:text-dark-1000">
          {t`Mark as completed column`}
          <span className="block text-xs text-neutral-600 dark:text-dark-800">
            {t`Cards moved into this list are marked as completed`}
          </span>
        </span>
      </label>
      {isCompleted && (
        <div className="mt-4 pl-6">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={autoArchiveEnabled}
              onChange={(e) => setAutoArchiveEnabled(e.target.checked)}
              className="mt-[2px]"
            />
            <span className="text-sm text-neutral-900 dark:text-dark-1000">
              {t`Auto-archive completed cards`}
              <span className="block text-xs text-neutral-600 dark:text-dark-800">
                {t`Automatically archive cards a set number of days after completion`}
              </span>
            </span>
          </label>
          {autoArchiveEnabled && (
            <div className="mt-2 flex items-center gap-2 pl-6">
              <label
                htmlFor="autoArchiveDays"
                className="text-xs font-medium text-neutral-700 dark:text-dark-900"
              >
                {t`Days`}
              </label>
              <input
                id="autoArchiveDays"
                type="number"
                min={1}
                max={365}
                value={autoArchiveDays}
                onChange={(e) => setAutoArchiveDays(Number(e.target.value))}
                className="w-20 rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000"
              />
            </div>
          )}
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button isLoading={updateList.isPending} onClick={handleSave}>
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
