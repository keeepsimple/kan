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

  // The member filter only makes sense for whoever can see everyone else's
  // analytics — resolveScope() on the server forces memberId to the caller
  // for everyone without analytics:view:all, so a member without that
  // permission would only ever see themself in the list anyway. Gate on the
  // explicit permission rather than a row-count heuristic (e.g. "more than
  // one member returned"), since that would misfire for a two-person
  // workspace where neither member has the permission.
  const permissions = api.permission.getMyPermissions.useQuery(
    { workspacePublicId: props.workspacePublicId },
    { enabled },
  );
  const canViewAllMembers =
    permissions.data?.permissions.includes("analytics:view:all") ?? false;

  // Dedicated lightweight endpoint (not api.workspace.byId): that query
  // privacy-strips member emails for non-admins, which would render this
  // select's options as raw publicIds for a non-admin holding
  // analytics:view:all via a permission override.
  const membersQuery = api.analytics.getMembers.useQuery(
    { workspacePublicId: props.workspacePublicId },
    { enabled: enabled && canViewAllMembers },
  );
  const members = membersQuery.data?.members ?? [];

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

      {canViewAllMembers && (
        <select
          value={props.memberPublicId ?? ""}
          onChange={(e) => props.onMemberChange(e.target.value || undefined)}
          className={selectClassName}
        >
          <option value="">{t`All members`}</option>
          {members.map((member) => (
            <option key={member.publicId} value={member.publicId}>
              {member.email}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
