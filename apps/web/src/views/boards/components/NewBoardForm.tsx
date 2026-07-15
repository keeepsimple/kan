import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { HiXMark } from "react-icons/hi2";
import { z } from "zod";

import type { Template } from "./TemplateBoards";
import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import Input from "~/components/Input";
import Toggle from "~/components/Toggle";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import TemplateBoards from "./TemplateBoards";

const schema = z.object({
  name: z
    .string()
    .min(1, { message: t`Board name is required` })
    .max(100, { message: t`Board name cannot exceed 100 characters` }),
  workspacePublicId: z.string(),
  template: z.custom<Template | null>(),
});

interface NewBoardInputWithTemplate {
  name: string;
  workspacePublicId: string;
  template: Template | null;
}

export function NewBoardForm({ isTemplate }: { isTemplate?: boolean }) {
  const utils = api.useUtils();
  const { closeModal } = useModal();
  const router = useRouter();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const [showTemplates, setShowTemplates] = useState(false);
  const { data: templates } = api.board.all.useQuery(
    { workspacePublicId: workspace.publicId ?? "", type: "template" },
    { enabled: !!workspace.publicId },
  );

  const [discordChannelId, setDiscordChannelId] = useState<string | null>(
    null,
  );

  const { data: discordStatus } = api.discord.getStatus.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const { data: discordChannels } = api.discord.listChannels.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId && !!discordStatus?.connected },
  );

  const formattedTemplates = templates?.map((template) => ({
    id: template.publicId,
    sourceBoardPublicId: template.publicId,
    name: template.name,
    lists: template.lists.map((list) => list.name),
    labels: template.labels.map((label) => label.name),
  }));

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<NewBoardInputWithTemplate>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      workspacePublicId: workspace.publicId || "",
      template: null,
    },
  });

  const currentTemplate = watch("template");

  const refetchBoards = () => utils.board.all.refetch();

  const createBoard = api.board.create.useMutation({
    onSuccess: async (board) => {
      if (!board) {
        showPopup({
          header: t`Error`,
          message: t`Failed to create board`,
          icon: "error",
        });
      } else {
        router.push(
          `${isTemplate ? "/templates" : "/boards"}/${board.publicId}`,
        );
      }
      closeModal();

      await refetchBoards();
    },
    onError: () => {
      showPopup({
        header: t`Error`,
        message: t`Failed to create board`,
        icon: "error",
      });
    },
  });

  const onSubmit = (data: NewBoardInputWithTemplate) => {
    createBoard.mutate({
      name: data.name,
      workspacePublicId: data.workspacePublicId,
      sourceBoardPublicId: data.template?.sourceBoardPublicId ?? undefined,
      lists: data.template?.lists ?? [],
      labels: data.template?.labels ?? [],
      type: isTemplate ? "template" : "regular",
      discordChannelId: discordChannelId ?? undefined,
    });
  };

  useEffect(() => {
    const titleElement: HTMLElement | null =
      document.querySelector<HTMLElement>("#name");
    if (titleElement) titleElement.focus();
  }, []);

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-5 pt-5">
        <div className="text-neutral-9000 flex w-full items-center justify-between pb-4 dark:text-dark-1000">
          <h2 className="text-sm font-bold">{t`New ${isTemplate ? "template" : "board"}`}</h2>
          <button
            type="button"
            className="hover:bg-li ght-300 rounded p-1 focus:outline-none dark:hover:bg-dark-300"
            onClick={(e) => {
              e.preventDefault();
              closeModal();
            }}
          >
            <HiXMark size={18} className="dark:text-dark-9000 text-light-900" />
          </button>
        </div>
        <Input
          id="name"
          placeholder={t`Name`}
          {...register("name", { required: true })}
          errorMessage={errors.name?.message}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              await handleSubmit(onSubmit)();
            }
          }}
        />
        {discordStatus?.connected && (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-neutral-700 dark:text-dark-900">
              {t`Discord channel (threads will be created here)`}
            </label>
            <CheckboxDropdown
              items={[
                {
                  key: "",
                  value: t`No channel`,
                  selected: !discordChannelId,
                },
                ...(discordChannels ?? []).map((channel) => ({
                  key: channel.id,
                  value: `#${channel.name}`,
                  selected: channel.id === discordChannelId,
                })),
              ]}
              handleSelect={(_groupKey, item) =>
                setDiscordChannelId(item.key || null)
              }
            >
              <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
                {discordChannelId
                  ? `#${
                      discordChannels?.find((c) => c.id === discordChannelId)
                        ?.name ?? discordChannelId
                    }`
                  : t`No channel`}
              </div>
            </CheckboxDropdown>
          </div>
        )}
      </div>
      <TemplateBoards
        currentBoard={currentTemplate}
        setCurrentBoard={(t) => setValue("template", t)}
        showTemplates={showTemplates}
        customTemplates={formattedTemplates ?? []}
      />
      <div className="mt-12 flex items-center justify-end space-x-4 border-t border-light-600 px-5 pb-5 pt-5 dark:border-dark-600">
        {!isTemplate && (
          <Toggle
            label={t`Use template`}
            isChecked={showTemplates}
            onChange={() => {
              setShowTemplates(!showTemplates);
              if (!showTemplates && !currentTemplate) {
                setValue("template", (templates?.[0] as any) ?? null);
              }
            }}
          />
        )}
        <div>
          <Button type="submit" isLoading={createBoard.isPending}>
            {t`Create ${isTemplate ? "template" : "board"}`}
          </Button>
        </div>
      </div>
    </form>
  );
}
