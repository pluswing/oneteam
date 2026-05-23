import type { PullRequestDto } from "../shared/types";
import { t } from "./i18n";

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
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
