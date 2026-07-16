import { useRouter } from "next/navigation";
import { t } from "@lingui/core/macro";
import { useState } from "react";

import Button from "~/components/Button";
import Select from "~/components/Select";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

export function MoveBoardForm({
  boardPublicId,
}: {
  boardPublicId: string;
}) {
  const router = useRouter();
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const { workspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const [targetWorkspacePublicId, setTargetWorkspacePublicId] = useState("");

  const otherWorkspaces = availableWorkspaces.filter(
    (ws) => ws.publicId !== workspace.publicId && ws.role !== "guest",
  );

  const moveBoard = api.board.move.useMutation({
    onSuccess: () => {
      const targetWorkspace = availableWorkspaces.find(
        (ws) => ws.publicId === targetWorkspacePublicId,
      );
      closeModal();
      showPopup({
        header: t`Board moved`,
        message: t`The board has been moved to ${targetWorkspace?.name ?? "the workspace"}.`,
        icon: "success",
      });
      if (targetWorkspace) {
        switchWorkspace(targetWorkspace);
      } else {
        router.push("/boards");
      }
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to move board`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const handleMoveBoard = () => {
    if (!targetWorkspacePublicId) return;
    moveBoard.mutate({
      boardPublicId,
      targetWorkspacePublicId,
    });
  };

  return (
    <div className="p-5">
      <div className="flex w-full flex-col justify-between pb-4">
        <h2 className="text-md pb-4 font-medium text-neutral-900 dark:text-dark-1000">
          {t`Move board to another workspace`}
        </h2>
        {otherWorkspaces.length === 0 ? (
          <p className="text-sm font-medium text-light-900 dark:text-dark-900">
            {t`You don't have any other workspaces to move this board to.`}
          </p>
        ) : (
          <>
            <label
              htmlFor="target-workspace"
              className="mb-2 text-sm font-medium text-light-900 dark:text-dark-900"
            >
              {t`Destination workspace`}
            </label>
            <Select
              id="target-workspace"
              value={targetWorkspacePublicId}
              onChange={setTargetWorkspacePublicId}
              options={[
                { value: "", label: t`Select a workspace` },
                ...otherWorkspaces.map((ws) => ({
                  value: ws.publicId,
                  label: ws.name,
                })),
              ]}
            />
            <p className="mt-3 text-sm text-light-800 dark:text-dark-800">
              {t`Card member assignments will be cleared when moving to a different workspace.`}
            </p>
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end space-x-2 sm:mt-6">
        <Button onClick={() => closeModal()} variant="secondary">
          {t`Cancel`}
        </Button>
        {otherWorkspaces.length > 0 && (
          <Button
            onClick={handleMoveBoard}
            isLoading={moveBoard.isPending}
            disabled={!targetWorkspacePublicId}
          >
            {t`Move board`}
          </Button>
        )}
      </div>
    </div>
  );
}
