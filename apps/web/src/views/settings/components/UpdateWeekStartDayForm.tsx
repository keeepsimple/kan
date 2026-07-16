import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";

import Select from "~/components/Select";
import { api } from "~/utils/api";

export default function UpdateWeekStartDayForm({
  workspacePublicId,
  weekStartDay,
  disabled = false,
}: {
  workspacePublicId: string;
  weekStartDay: number;
  disabled?: boolean;
}) {
  const utils = api.useUtils();
  const [value, setValue] = useState(weekStartDay);

  useEffect(() => {
    setValue(weekStartDay);
  }, [weekStartDay]);

  const updateWorkspace = api.workspace.update.useMutation({
    onSuccess: () => {
      if (workspacePublicId && workspacePublicId.length >= 12) {
        void utils.workspace.byId.invalidate({
          workspacePublicId,
        });
        void utils.workspace.all.invalidate();
      }
    },
  });

  const handleChange = (newValue: number) => {
    if (disabled) return;
    setValue(newValue);
    updateWorkspace.mutate({
      workspacePublicId,
      weekStartDay: newValue as 0 | 1 | 6,
    });
  };

  return (
    <div className="flex gap-2">
      <div className="mb-4 flex w-full max-w-[325px] items-center gap-2">
        <Select
          wrapperClassName="w-full"
          value={String(value)}
          onChange={(v) => handleChange(Number(v))}
          disabled={disabled || updateWorkspace.isPending}
          options={[
            { value: "0", label: t`Sunday` },
            { value: "1", label: t`Monday` },
            { value: "6", label: t`Saturday` },
          ]}
        />
      </div>
    </div>
  );
}
