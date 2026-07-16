import { t } from "@lingui/core/macro";

import { api } from "~/utils/api";

interface Props {
  range: number;
  onRangeChange: (n: number) => void;
  boardPublicId?: string;
  onBoardChange: (v: string | undefined) => void;
  memberPublicId?: string;
  onMemberChange: (v: string | undefined) => void;
  workspacePublicId: string;
}

const selectClassName =
  "block w-full rounded-md border-0 bg-dark-300 bg-white/5 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-600 placeholder:text-dark-800 focus:ring-2 focus:ring-inset focus:ring-light-700 dark:text-dark-1000 dark:ring-dark-700 dark:focus:ring-dark-700 sm:leading-6";

export default function AnalyticsFilters(props: Props) {
  const enabled = props.workspacePublicId.length >= 12;
  const boards = api.board.all.useQuery(
    { workspacePublicId: props.workspacePublicId, type: "regular" },
    { enabled },
  );

  return (
    <div className="flex flex-wrap gap-3">
      <select
        value={props.range}
        onChange={(e) => props.onRangeChange(Number(e.target.value))}
        className={selectClassName}
      >
        <option value={7}>{t`Last 7 days`}</option>
        <option value={30}>{t`Last 30 days`}</option>
        <option value={90}>{t`Last 90 days`}</option>
      </select>

      <select
        value={props.boardPublicId ?? ""}
        onChange={(e) => props.onBoardChange(e.target.value || undefined)}
        className={selectClassName}
      >
        <option value="">{t`All boards`}</option>
        {boards.data?.map((board) => (
          <option key={board.publicId} value={board.publicId}>
            {board.name}
          </option>
        ))}
      </select>
    </div>
  );
}
