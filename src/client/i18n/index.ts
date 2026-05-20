import { en } from "./locales/en/common";

type Resource = typeof en;

function readKey(resource: Resource, key: string): string {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, resource);

  return typeof value === "string" ? value : key;
}

export function t(key: string): string {
  return readKey(en, key);
}
