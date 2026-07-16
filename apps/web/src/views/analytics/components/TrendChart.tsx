import { format, parseISO } from "date-fns";
import { useTheme } from "next-themes";
import type { DotItemDotProps } from "recharts";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { t } from "@lingui/core/macro";

import { useLocalisation } from "~/hooks/useLocalisation";

interface Point {
  day: string;
  count: number;
}

// dataviz reference palette (references/palette.md) — a single series is a
// sequential encoding, so it gets one hue (categorical slot 1, "blue"),
// stepped for the light/dark chart surface rather than a raw recharts default.
const SERIES_COLOR = { light: "#2a78d6", dark: "#3987e5" };
const GRIDLINE_COLOR = { light: "#e1e0d9", dark: "#2c2c2a" };
const SURFACE_COLOR = { light: "#fcfcfb", dark: "#1a1a19" };
const PRIMARY_INK = { light: "#0b0b0b", dark: "#ffffff" };
// Muted axis/label ink is the same step in both modes (palette.md chart chrome).
const AXIS_COLOR = "#898781";

export default function TrendChart({ points }: { points?: Point[] }) {
  const { resolvedTheme } = useTheme();
  const { dateLocale, formatNumber } = useLocalisation();

  if (!points?.length) return null;

  const isDark = resolvedTheme === "dark";
  const seriesColor = isDark ? SERIES_COLOR.dark : SERIES_COLOR.light;
  const gridColor = isDark ? GRIDLINE_COLOR.dark : GRIDLINE_COLOR.light;
  const surfaceColor = isDark ? SURFACE_COLOR.dark : SURFACE_COLOR.light;
  const primaryInk = isDark ? PRIMARY_INK.dark : PRIMARY_INK.light;

  const lastDay = points[points.length - 1]?.day;

  // Mark spec: an end-dot (>=8px incl. ring) on the most recent point only —
  // "label the endpoint," not a dot flooding every point on the line.
  const renderEndDot = (dotProps: DotItemDotProps) => {
    const point = dotProps.payload as Point | undefined;
    if (!point || point.day !== lastDay) return null;
    return (
      <circle
        cx={dotProps.cx}
        cy={dotProps.cy}
        r={4}
        fill={seriesColor}
        stroke={surfaceColor}
        strokeWidth={2}
      />
    );
  };

  return (
    <div className="mt-4 rounded-lg border border-light-300 bg-light-50 p-4 dark:border-dark-300 dark:bg-dark-100">
      <div className="mb-2 text-xs font-medium text-light-800 dark:text-dark-800">
        {t`Activity over time`}
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke={gridColor} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: AXIS_COLOR }}
              axisLine={{ stroke: gridColor }}
              tickLine={false}
              minTickGap={24}
              tickFormatter={(value) =>
                format(parseISO(value as string), "MMM d", {
                  locale: dateLocale,
                })
              }
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: AXIS_COLOR }}
              axisLine={false}
              tickLine={false}
              width={36}
              tickFormatter={(value) => formatNumber(value as number)}
            />
            <Tooltip
              cursor={{ stroke: gridColor, strokeWidth: 1 }}
              contentStyle={{
                backgroundColor: surfaceColor,
                border: `1px solid ${gridColor}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: primaryInk, fontWeight: 600 }}
              itemStyle={{ color: primaryInk }}
              labelFormatter={(label) =>
                format(parseISO(label as string), "MMM d, yyyy", {
                  locale: dateLocale,
                })
              }
              formatter={(value) => [
                typeof value === "number" ? formatNumber(value) : String(value),
                t`Activity`,
              ]}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke={seriesColor}
              strokeWidth={2}
              fill={seriesColor}
              fillOpacity={0.12}
              dot={renderEndDot}
              activeDot={{
                r: 4,
                fill: seriesColor,
                stroke: surfaceColor,
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
