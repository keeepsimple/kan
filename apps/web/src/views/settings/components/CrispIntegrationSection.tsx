import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import Button from "~/components/Button";
import Input from "~/components/Input";
import Select from "~/components/Select";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

const crispFormSchema = z.object({
  crispWebsiteId: z.string().min(1, { message: t`Website ID is required` }),
  boardPublicId: z.string().min(12, { message: t`Board is required` }),
  listPublicId: z.string().min(12, { message: t`List is required` }),
});

type CrispFormValues = z.infer<typeof crispFormSchema>;

export function CrispIntegrationSection({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const { data: integration, isLoading } = api.crispIntegration.get.useQuery({
    workspacePublicId,
  });

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    resetField,
    formState: { errors },
  } = useForm<CrispFormValues>({
    resolver: zodResolver(crispFormSchema),
    defaultValues: { crispWebsiteId: "", boardPublicId: "", listPublicId: "" },
  });

  const selectedBoardPublicId = watch("boardPublicId");

  const { data: boards } = api.board.all.useQuery(
    { workspacePublicId, type: "regular" },
    { enabled: !isLoading && !integration },
  );

  const { data: selectedBoard } = api.board.byId.useQuery(
    { boardPublicId: selectedBoardPublicId, type: "regular" },
    { enabled: selectedBoardPublicId.length >= 12 },
  );

  const lists = selectedBoard?.allLists ?? [];

  const createIntegration = api.crispIntegration.create.useMutation({
    onSuccess: async () => {
      await utils.crispIntegration.get.invalidate({ workspacePublicId });
      reset();
      showPopup({
        header: t`Crisp connected`,
        message: t`Copy the webhook URL into your Crisp dashboard to finish setup.`,
        icon: "success",
      });
    },
    onError: () => {
      showPopup({
        header: t`Error connecting Crisp`,
        message: t`An error occurred while connecting Crisp.`,
        icon: "error",
      });
    },
  });

  const disconnectIntegration = api.crispIntegration.disconnect.useMutation({
    onSuccess: async () => {
      await utils.crispIntegration.get.invalidate({ workspacePublicId });
      reset();
      showPopup({
        header: t`Crisp disconnected`,
        message: t`The Crisp integration has been removed.`,
        icon: "success",
      });
    },
    onError: () => {
      showPopup({
        header: t`Error disconnecting Crisp`,
        message: t`An error occurred while disconnecting Crisp.`,
        icon: "error",
      });
    },
  });

  const onSubmit = (values: CrispFormValues) => {
    createIntegration.mutate({
      workspacePublicId,
      crispWebsiteId: values.crispWebsiteId,
      listPublicId: values.listPublicId,
    });
  };

  const copyWebhookUrl = async () => {
    if (!integration) return;
    await navigator.clipboard.writeText(integration.webhookUrl);
    showPopup({
      header: t`Copied`,
      message: t`Webhook URL copied to clipboard.`,
      icon: "success",
    });
  };

  return (
    <div className="mb-8 border-t border-light-300 dark:border-dark-300">
      <h2 className="mb-4 mt-8 text-[14px] font-bold text-neutral-900 dark:text-dark-1000">
        {t`Crisp`}
      </h2>
      {integration ? (
        <>
          <p className="mb-4 text-sm text-neutral-500 dark:text-dark-900">
            {t`Crisp is connected. Operator notes starting with #card create cards in`}{" "}
            <span className="font-medium">
              {integration.board.name} / {integration.list.name}
            </span>
            .
          </p>
          <div className="mb-4 flex w-full max-w-[500px] items-center gap-2">
            <Input readOnly value={integration.webhookUrl} />
            <Button variant="secondary" onClick={() => void copyWebhookUrl()}>
              {t`Copy`}
            </Button>
          </div>
          <ol className="mb-8 list-decimal pl-5 text-sm text-neutral-500 dark:text-dark-900">
            <li>{t`In Crisp, go to Settings → Websites → your website → Web Hooks and paste this URL.`}</li>
            <li>{t`Subscribe the hook to message events.`}</li>
            <li>{t`In a conversation, write a private note starting with #card followed by the card title.`}</li>
            <li>{t`Optional: create a Crisp shortcut !card that expands to #card for faster typing.`}</li>
          </ol>
          <Button
            variant="secondary"
            onClick={() => disconnectIntegration.mutate({ workspacePublicId })}
          >
            {t`Disconnect Crisp`}
          </Button>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-neutral-500 dark:text-dark-900">
            {t`Create cards from Crisp conversations: choose a target board and list, then paste the generated webhook URL into your Crisp dashboard.`}
          </p>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="flex max-w-[325px] flex-col gap-3"
          >
            <Input
              placeholder={t`Crisp Website ID`}
              {...register("crispWebsiteId")}
              errorMessage={errors.crispWebsiteId?.message}
            />
            <div className="flex flex-col gap-1">
              <Controller
                control={control}
                name="boardPublicId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onChange={(v) => {
                      field.onChange(v);
                      resetField("listPublicId");
                    }}
                    options={[
                      { value: "", label: t`Select a board` },
                      ...(boards ?? []).map((board) => ({
                        value: board.publicId,
                        label: board.name,
                      })),
                    ]}
                  />
                )}
              />
              {errors.boardPublicId && (
                <div className="text-xs text-red-500">
                  {errors.boardPublicId.message}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Controller
                control={control}
                name="listPublicId"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onChange={field.onChange}
                    disabled={!lists.length}
                    options={[
                      { value: "", label: t`Select a list` },
                      ...lists.map((list) => ({
                        value: list.publicId,
                        label: list.name,
                      })),
                    ]}
                  />
                )}
              />
              {errors.listPublicId && (
                <div className="text-xs text-red-500">
                  {errors.listPublicId.message}
                </div>
              )}
            </div>
            <div>
              <Button
                variant="primary"
                type="submit"
                isLoading={createIntegration.isPending}
                disabled={createIntegration.isPending}
              >
                {t`Connect Crisp`}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
