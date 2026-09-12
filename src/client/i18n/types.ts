import type { en } from "./locales/en/common";

export type LocaleResource<T = typeof en> = {
  readonly [K in keyof T]: T[K] extends string ? string : LocaleResource<T[K]>;
};
