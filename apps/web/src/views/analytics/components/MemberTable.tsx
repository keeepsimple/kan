import { t } from "@lingui/core/macro";

import { useLocalisation } from "~/hooks/useLocalisation";

interface Row {
  memberPublicId: string;
  email: string;
  activity: number;
  completed: number;
  onTime: number;
  late: number;
  overdue: number;
  avgCycleTimeSeconds: number;
}

const headerClassName =
  "px-4 py-2 text-xs font-semibold tracking-wide text-light-900 dark:text-dark-900";
const cellClassName =
  "px-4 py-3 text-sm text-light-900 dark:text-dark-900";

export default function MemberTable({ rows }: { rows?: Row[] }) {
  const { formatNumber } = useLocalisation();

  if (!rows?.length) return null;

  return (
    <div className="mt-4 rounded-lg border border-light-300 bg-light-50 p-4 dark:border-dark-300 dark:bg-dark-100">
      <div className="mb-3 text-xs font-medium text-light-800 dark:text-dark-800">
        {t`By member`}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead className="bg-light-300 dark:bg-dark-300">
            <tr>
              <th className={`${headerClassName} rounded-tl-md`}>{t`Member`}</th>
              <th className={`${headerClassName} text-right`}>{t`Activity`}</th>
              <th className={`${headerClassName} text-right`}>{t`Completed`}</th>
              <th className={`${headerClassName} text-right`}>{t`On-time`}</th>
              <th className={`${headerClassName} rounded-tr-md text-right`}>
                {t`Overdue`}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-light-600 dark:divide-dark-600">
            {rows.map((row) => {
              const decided = row.onTime + row.late;
              const onTimePct = decided > 0 ? row.onTime / decided : null;
              return (
                <tr key={row.memberPublicId}>
                  <td className={cellClassName}>{row.email}</td>
                  <td className={`${cellClassName} text-right tabular-nums`}>
                    {formatNumber(row.activity)}
                  </td>
                  <td className={`${cellClassName} text-right tabular-nums`}>
                    {formatNumber(row.completed)}
                  </td>
                  <td className={`${cellClassName} text-right tabular-nums`}>
                    {onTimePct !== null
                      ? formatNumber(onTimePct, {
                          style: "percent",
                          maximumFractionDigits: 0,
                        })
                      : "—"}
                  </td>
                  <td className={`${cellClassName} text-right tabular-nums`}>
                    {formatNumber(row.overdue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
