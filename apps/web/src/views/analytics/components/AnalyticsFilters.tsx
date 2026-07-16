import { t } from "@lingui/core/macro";

import Select from "~/components/Select";
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
      <Select
        wrapperClassName="min-w-[150px] flex-1"
        value={String(props.range)}
        onChange={(v) => props.onRangeChange(Number(v))}
        options={[
          { value: "7", label: t`Last 7 days` },
          { value: "30", label: t`Last 30 days` },
          { value: "90", label: t`Last 90 days` },
        ]}
      />

      <Select
        wrapperClassName="min-w-[150px] flex-1"
        value={props.boardPublicId ?? ""}
        onChange={(v) => props.onBoardChange(v || undefined)}
        options={[
          { value: "", label: t`All boards` },
          ...(boards.data ?? []).map((board) => ({
            value: board.publicId,
            label: board.name,
          })),
        ]}
      />

      {canViewAllMembers && (
        <Select
          wrapperClassName="min-w-[150px] flex-1"
          value={props.memberPublicId ?? ""}
          onChange={(v) => props.onMemberChange(v || undefined)}
          options={[
            { value: "", label: t`All members` },
            ...members.map((member) => ({
              value: member.publicId,
              label: member.email,
            })),
          ]}
        />
      )}
    </div>
  );
}
