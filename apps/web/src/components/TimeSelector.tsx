import { t } from "@lingui/core/macro";

import Select from "~/components/Select";

interface TimeSelectorProps {
  value: Date | null | undefined;
  onChange: (hours: number, minutes: number) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

const selectClassName = "rounded-[5px] py-1 pl-2 pr-1.5 text-xs";

// 24h time picker (native <input type="time"> shows AM/PM depending on OS locale)
const TimeSelector = ({ value, onChange }: TimeSelectorProps) => (
  <div className="flex w-full items-center gap-1 text-xs text-neutral-900 dark:text-dark-1000">
    <Select
      aria-label={t`Hours`}
      wrapperClassName="flex-1"
      className={selectClassName}
      value={value ? String(value.getHours()) : ""}
      disabled={!value}
      onChange={(v) => value && onChange(Number(v), value.getMinutes())}
      options={Array.from({ length: 24 }, (_, h) => ({
        value: String(h),
        label: pad(h),
      }))}
    />
    :
    <Select
      aria-label={t`Minutes`}
      wrapperClassName="flex-1"
      className={selectClassName}
      value={value ? String(value.getMinutes()) : ""}
      disabled={!value}
      onChange={(v) => value && onChange(value.getHours(), Number(v))}
      options={Array.from({ length: 60 }, (_, m) => ({
        value: String(m),
        label: pad(m),
      }))}
    />
  </div>
);

export default TimeSelector;
