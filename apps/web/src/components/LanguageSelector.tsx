import { HiLanguage } from "react-icons/hi2";

import Select from "~/components/Select";
import { useLocalisation } from "~/hooks/useLocalisation";
import { localeNames } from "~/locales";

export function LanguageSelector() {
  const { locale, setLocale, availableLocales } = useLocalisation();

  return (
    <Select
      id="language-select"
      wrapperClassName="mt-8 w-full max-w-[180px]"
      iconLeft={<HiLanguage className="h-4 w-4" />}
      value={locale}
      onChange={(value) =>
        setLocale(value as (typeof availableLocales)[number])
      }
      options={availableLocales.map((loc) => ({
        value: loc,
        label: localeNames[loc],
      }))}
    />
  );
}
