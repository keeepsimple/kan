import { t } from "@lingui/core/macro";
import { HiOutlineAdjustmentsHorizontal } from "react-icons/hi2";

import type { FontSize } from "~/providers/font-size";
import Select from "~/components/Select";
import { useFontSize } from "~/providers/font-size";

const fontSizeOptions: { value: FontSize; label: () => string }[] = [
  { value: "small", label: () => t`Small` },
  { value: "medium", label: () => t`Medium` },
  { value: "large", label: () => t`Large` },
];

export function FontSizeSelector() {
  const { fontSize, setFontSize } = useFontSize();

  return (
    <Select
      id="font-size-select"
      wrapperClassName="w-full max-w-[180px]"
      iconLeft={<HiOutlineAdjustmentsHorizontal className="h-4 w-4" />}
      value={fontSize}
      onChange={(value) => setFontSize(value as FontSize)}
      options={fontSizeOptions.map((opt) => ({
        value: opt.value,
        label: opt.label(),
      }))}
    />
  );
}
