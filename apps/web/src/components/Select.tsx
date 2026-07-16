import type { ReactNode } from "react";
import { Listbox } from "@headlessui/react";
import { HiCheck, HiChevronDown } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  wrapperClassName?: string;
  className?: string;
  iconLeft?: ReactNode;
  trigger?: ReactNode;
  "aria-label"?: string;
}

// Styled replacement for native <select>: custom trigger and options menu
// (Headless UI Listbox), matching Input/Dropdown styling. Options are
// anchored via a portal so they never get clipped by overflow containers.
export default function Select({
  value,
  onChange,
  options,
  disabled,
  id,
  placeholder,
  wrapperClassName,
  className,
  iconLeft,
  trigger,
  "aria-label": ariaLabel,
}: SelectProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <Listbox
      as="div"
      className={twMerge("relative", wrapperClassName)}
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      <Listbox.Button
        id={id}
        aria-label={ariaLabel}
        className={
          trigger
            ? twMerge(
                "block cursor-pointer focus:outline-none disabled:cursor-not-allowed",
                className,
              )
            : twMerge(
                "flex w-full cursor-pointer items-center gap-2 rounded-md bg-white/5 py-1.5 pl-3 pr-2.5 text-left text-sm text-neutral-900 shadow-sm ring-1 ring-inset ring-light-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-light-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-dark-1000 dark:ring-dark-700 dark:focus-visible:ring-dark-700 sm:leading-6",
                className,
              )
        }
      >
        {trigger ?? (
          <>
            {iconLeft && (
              <span className="pointer-events-none shrink-0 text-gray-400">
                {iconLeft}
              </span>
            )}
            <span className="block flex-1 truncate">
              {selected?.label ?? placeholder ?? " "}
            </span>
            <HiChevronDown className="pointer-events-none h-4 w-4 shrink-0 text-light-900 dark:text-dark-900" />
          </>
        )}
      </Listbox.Button>
      <Listbox.Options
        anchor={{ to: "bottom start", gap: 4 }}
        className="z-[100] max-h-60 min-w-[var(--button-width)] overflow-auto rounded-md border border-light-200 bg-white p-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none dark:border-dark-400 dark:bg-dark-300"
      >
        {options.map((option) => (
          <Listbox.Option
            key={option.value}
            value={option.value}
            className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-[5px] px-2.5 py-1.5 text-sm text-neutral-900 data-[focus]:bg-light-200 dark:text-dark-950 dark:data-[focus]:bg-dark-400"
          >
            <span className="block truncate">{option.label || " "}</span>
            {option.value === value && (
              <HiCheck className="h-3.5 w-3.5 shrink-0" />
            )}
          </Listbox.Option>
        ))}
      </Listbox.Options>
    </Listbox>
  );
}
