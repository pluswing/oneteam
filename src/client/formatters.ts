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

// Keep identifiers in API data intact; translate known values only at display boundaries.
const japaneseDisplayValues: Record<string, string> = {
  passed: "成功", success: "成功", approved: "承認済み", resolved: "解決済み", done: "完了", error: "エラー",
  in_progress: "実行中", inProgress: "実行中", started: "開始", timed_out: "時間切れ", rejected: "却下",
  defects_found: "不具合あり", changes_requested: "修正が必要", cancelled: "キャンセル済み",
  waiting_input: "入力待ち", waiting_capacity: "利用枠待ち", add: "追加", update: "変更", delete: "削除", added: "追加", modified: "変更", deleted: "削除",
  requirements: "要件定義", implementation: "実装", review: "レビュー", fix: "修正",
  qa: "品質確認", verifier: "最終検証", command_detection: "コマンド検出", retrospective: "振り返り",
  open: "未完了", closed: "完了", merged: "マージ済み", queued: "実行待ち", running: "実行中",
  paused: "一時停止", waiting_provider: "利用枠待ち", waiting_human: "確認待ち",
  succeeded: "完了", completed: "完了", failed: "失敗", canceled: "キャンセル済み",
  active: "進行中", pending: "待機中", stopped: "停止", interrupted: "中断",
  applied: "適用済み", restoring: "復元中", restored: "復元済み", skipped: "省略",
  issue: "課題", pull_request: "プルリクエスト", project: "プロジェクト",
  user: "ユーザー", system: "システム", agent: "エージェント",
  low: "低", medium: "中", high: "高", critical: "緊急", xhigh: "非常に高", minimal: "最小", none: "なし",
  manual: "手動", repository_imported: "リポジトリの取り込み", issue_created: "課題の作成",
  issue_updated: "課題の更新", comment_created: "コメントの追加", pull_request_created: "プルリクエストの作成",
  pull_request_updated: "プルリクエストの更新", development_loop: "開発の自動処理", retry: "再試行"
};

export function formatDisplayValue(value: string): string {
  return getLocale() === "ja" ? japaneseDisplayValues[value] ?? value : value;
}
