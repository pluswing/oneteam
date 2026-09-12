import { en } from "./locales/en/common";
import { ja } from "./locales/ja/common";
import { normalizeLocale, type SupportedLocale } from "../../shared/locales";
import type { LocaleResource } from "./types";

const resources: Record<SupportedLocale, LocaleResource> = {
  en,
  ja
};

let currentLocale: SupportedLocale = normalizeLocale(
  typeof navigator === "undefined" ? undefined : navigator.language
);

function readKey(resource: LocaleResource, key: string): string {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, resource);

  return typeof value === "string" ? value : key;
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function setLocale(locale: string): SupportedLocale {
  currentLocale = normalizeLocale(locale);
  return currentLocale;
}

export function t(key: string): string {
  return readKey(resources[currentLocale] ?? en, key);
}
