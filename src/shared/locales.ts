export const supportedLocales = ["en", "ja"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

export function normalizeLocale(value: string | null | undefined): SupportedLocale {
  const locale = value?.toLowerCase();
  if (locale?.startsWith("ja")) {
    return "ja";
  }
  return "en";
}

export function localeLabel(locale: SupportedLocale): string {
  return locale === "ja" ? "日本語" : "English";
}

export function localeLanguageName(locale: string | null | undefined): string {
  return normalizeLocale(locale) === "ja" ? "Japanese" : "English";
}
