import { useMemo, useState } from "react";
import { startOfDay, subDays } from "date-fns";

import { t } from "@lingui/core/macro";

import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import AnalyticsFilters from "./components/AnalyticsFilters";
import KpiRow from "./components/KpiRow";
import MemberTable from "./components/MemberTable";
import TrendChart from "./components/TrendChart";

function daysAgo(n: number) {
  return startOfDay(subDays(new Date(), n));
}

export default function AnalyticsView() {
  const { workspace } = useWorkspace();
  const [range, setRange] = useState(30);
  const [boardPublicId, setBoardPublicId] = useState<string | undefined>();
  const [memberPublicId, setMemberPublicId] = useState<string | undefined>();

  const filter = useMemo(
    () => ({
      workspacePublicId: workspace.publicId,
      from: daysAgo(range),
      to: new Date(),
      boardPublicId,
      memberPublicId,
    }),
    [workspace.publicId, range, boardPublicId, memberPublicId],
  );
  const enabled = !!workspace.publicId && workspace.publicId.length >= 12;

  const overview = api.analytics.getOverview.useQuery(filter, { enabled });
  const breakdown = api.analytics.getMemberBreakdown.useQuery(filter, {
    enabled,
  });
  const series = api.analytics.getTimeSeries.useQuery(filter, { enabled });

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-medium text-neutral-900 dark:text-dark-1000">
        {t`Analytics`}
      </h1>
      <AnalyticsFilters
        range={range}
        onRangeChange={setRange}
        boardPublicId={boardPublicId}
        onBoardChange={setBoardPublicId}
        memberPublicId={memberPublicId}
        onMemberChange={setMemberPublicId}
        workspacePublicId={workspace.publicId}
      />
      <div className="mt-4">
        <KpiRow data={overview.data} />
      </div>
      <TrendChart points={series.data?.points} />
      <MemberTable rows={breakdown.data?.members} />
    </div>
  );
}
