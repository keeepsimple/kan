import { t } from "@lingui/core/macro";

import { useLocalisation } from "~/hooks/useLocalisation";

interface Overview {
  totalActivity: number;
  completedCards: number;
  onTimeRate: number;
  avgCycleTimeSeconds: number;
  previous: {
    totalActivity: number;
    completedCards: number;
    onTimeRate: number;
    avgCycleTimeSeconds: number;
  };
}

type FormatNumber = (value: number, format?: Intl.NumberFormatOptions) => string;

interface Tile {
  label: string;
  value: string;
  delta: number;
  hasDelta: boolean;
  higherIsBetter: boolean;
}

// Relative change vs. the previous period, expressed as a fraction (0.12 = +12%).
// prev === 0 is "new" activity: +100% when cur > 0, otherwise flat.
function relativeChange(cur: number, prev: number): number {
  if (prev === 0) return cur === 0 ? 0 : 1;
  return (cur - prev) / prev;
}

function formatDuration(seconds: number, formatNumber: FormatNumber): string {
  if (seconds <= 0) return "—";
  const days = seconds / 86400;
  if (days >= 1) return `${formatNumber(days, { maximumFractionDigits: 1 })}d`;
  return `${formatNumber(seconds / 3600, { maximumFractionDigits: 1 })}h`;
}

// dataviz: delta is a status signal, not decoration — color = direction ×
// whether "up" is actually good for this metric (lower cycle time is good).
// Zero change is neutral ink, never green or red.
function deltaClassName(delta: number, higherIsBetter: boolean): string {
  if (delta === 0) return "text-light-800 dark:text-dark-800";
  const isGood = higherIsBetter ? delta > 0 : delta < 0;
  return isGood
    ? "text-green-600 dark:text-green-400"
    : "text-red-600 dark:text-red-400";
}

export default function KpiRow({ data }: { data?: Overview }) {
  const { formatNumber } = useLocalisation();

  if (!data) return null;

  const compact: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: 1,
  };

  const tiles: Tile[] = [
    {
      label: t`Total activity`,
      value: formatNumber(data.totalActivity, compact),
      delta: relativeChange(data.totalActivity, data.previous.totalActivity),
      hasDelta: true,
      higherIsBetter: true,
    },
    {
      label: t`Completed cards`,
      value: formatNumber(data.completedCards, compact),
      delta: relativeChange(
        data.completedCards,
        data.previous.completedCards,
      ),
      hasDelta: true,
      higherIsBetter: true,
    },
    {
      label: t`On-time rate`,
      value: formatNumber(data.onTimeRate, {
        style: "percent",
        maximumFractionDigits: 0,
      }),
      delta: relativeChange(data.onTimeRate, data.previous.onTimeRate),
      hasDelta: true,
      higherIsBetter: true,
    },
    {
      label: t`Avg cycle time`,
      value: formatDuration(data.avgCycleTimeSeconds, formatNumber),
      delta: relativeChange(
        data.avgCycleTimeSeconds,
        data.previous.avgCycleTimeSeconds,
      ),
      // Nothing to compare yet if there's no completed-card cycle time at all.
      hasDelta: data.avgCycleTimeSeconds > 0,
      higherIsBetter: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-lg border border-light-300 bg-light-50 p-4 dark:border-dark-300 dark:bg-dark-100"
        >
          <div className="text-xs font-medium text-light-800 dark:text-dark-800">
            {tile.label}
          </div>
          <div className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-dark-1000">
            {tile.value}
          </div>
          {tile.hasDelta && (
            <div className="mt-1 flex items-baseline gap-1 text-xs font-medium">
              <span className={deltaClassName(tile.delta, tile.higherIsBetter)}>
                {formatNumber(tile.delta, {
                  style: "percent",
                  maximumFractionDigits: 0,
                  signDisplay: "exceptZero",
                })}
              </span>
              <span className="text-light-800 dark:text-dark-800">
                {t`vs previous period`}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
