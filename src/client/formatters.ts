import type { PullRequestDto } from "../shared/types";
import { getLocale, t } from "./i18n";

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString(getLocale() === "ja" ? "ja-JP" : "en-US");
}

export function formatPullRequestStatus(status: PullRequestDto["status"]): string {
  if (status === "open") {
    return t("pullRequests.open");
  }
  if (status === "merged") {
    return t("pullRequests.merged");
  }
  return t("pullRequests.closed");
}
