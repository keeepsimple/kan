import { t } from "@lingui/core/macro";

interface TimeSelectorProps {
  value: Date | null | undefined;
  onChange: (hours: number, minutes: number) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

const selectClassName =
  "flex-1 rounded-[5px] border border-light-200 bg-transparent px-1 py-1 text-center text-xs text-neutral-900 disabled:opacity-50 dark:border-dark-200 dark:text-dark-1000 dark:[color-scheme:dark]";

// 24h time picker (native <input type="time"> shows AM/PM depending on OS locale)
const TimeSelector = ({ value, onChange }: TimeSelectorProps) => (
  <div className="flex w-full items-center gap-1 text-xs text-neutral-900 dark:text-dark-1000">
    <select
      aria-label={t`Hours`}
      value={value ? value.getHours() : ""}
      disabled={!value}
      onChange={(e) => value && onChange(Number(e.target.value), value.getMinutes())}
      className={selectClassName}
    >
      {!value && <option value="" />}
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {pad(h)}
        </option>
      ))}
    </select>
    :
    <select
      aria-label={t`Minutes`}
      value={value ? value.getMinutes() : ""}
      disabled={!value}
      onChange={(e) => value && onChange(value.getHours(), Number(e.target.value))}
      className={selectClassName}
    >
      {!value && <option value="" />}
      {Array.from({ length: 60 }, (_, m) => (
        <option key={m} value={m}>
          {pad(m)}
        </option>
      ))}
    </select>
  </div>
);

export default TimeSelector;
