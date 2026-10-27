import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ScanFailureDiagnosis } from "../../shared/vulnerabilities";

/** Persist diagnostics, never credentials emitted by a CLI or registry. */
export function redactInspectionError(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strip terminal escapes from untrusted scanner output.
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:gh[pousr]_[a-z\d]{8,}|github_pat_[a-z\d_]{8,}|glpat-[a-z\d_-]{8,}|sk-(?:proj-|svcacct-)?[a-z\d_-]{8,}|xox[baprs]-[a-z\d-]{8,}|(?:AKIA|ASIA)[A-Z\d]{16})\b/gi, "[redacted]")
    .replace(/\b(?:[a-z\d]+[-_])*(?:credential|secret|token)[-_][a-z\d_-]+\b/gi, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[a-z\d+/=_~.-]+/gi, "$1 [redacted]")
    .replace(/((?:[?&]|\b)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|client[_-]?secret|secret|api[_-]?key|authorization|auth|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]")
    // eslint-disable-next-line no-control-regex -- Preserve newlines/tabs while removing other terminal controls.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export class InspectionError extends Error {
  readonly command: string;
  readonly code: number | string | null;
  readonly stderr: string;
  diagnosis: ScanFailureDiagnosis;

  constructor(message: string, options: { command: string; code?: number | string | null; stderr?: string; diagnosis?: ScanFailureDiagnosis }) {
    super(redactInspectionError(message));
    this.name = "InspectionError";
    this.command = basename(options.command);
    this.code = options.code ?? null;
    this.stderr = redactInspectionError(options.stderr ?? "").slice(-16_000);
    this.diagnosis = options.diagnosis ? { ...options.diagnosis, summary: redactInspectionError(options.diagnosis.summary),
      details: redactInspectionError(options.diagnosis.details).slice(-16_000), attemptedActions: options.diagnosis.attemptedActions.map(redactInspectionError) }
      : diagnoseText(this.stderr ? `${this.command} (exit ${this.code ?? "unknown"})\n${this.stderr}` : this.message, this.command, this.code);
  }
}

/** Also accepts legacy errors from adapters and injected scanners. */
export function diagnoseInspectionFailure(error: unknown, command = "trivy"): ScanFailureDiagnosis {
  if (error instanceof InspectionError) return error.diagnosis;
  const message = redactInspectionError(error instanceof Error ? error.message : String(error));
  return diagnoseText(message, basename(command), null);
}

function diagnoseText(message: string, command: string, code: number | string | null): ScanFailureDiagnosis {
  let category: ScanFailureDiagnosis["category"] = "unknown";
  let summary = "検査ツールがエラーを返しました。詳細に記録された原因の修正が必要です。";
  let retryable = false;
  const database = /(?:vulnerability|java|index)\s+(?:database|db)|(?:database|db)\s+(?:error|download|schema)|trivy(?:-java)?-db|\/db\/|\/java-db\//i.test(message);
  if (/cancelled|canceled|aborted/i.test(message)) {
    summary = "脆弱性検査が中断されました。";
  } else if (/no space left on device|disk quota exceeded|ENOSPC/i.test(message)) {
    category = "cache";
    summary = "検査に必要なディスク空き容量が不足しています。不要なファイルを整理してから再検査してください。";
  } else if (/certificate|x509|tls.*(?:handshake|verify)|self[- ]signed/i.test(message)) {
    category = "configuration";
    summary = "検査先の証明書を検証できません。信頼できるCA証明書やプロキシ設定の修正が必要です。";
  } else if (/unauthorized|unauthenticated|authentication required|DENIED|forbidden|HTTP\s*(?:401|403)|permission denied.*publickey/i.test(message)) {
    category = "authentication";
    retryable = database;
    summary = database ? "公開脆弱性データベースの取得時に認証エラーが発生しました。" : "検査対象への認証またはアクセス権限が不足しています。接続先の認証設定が必要です。";
  } else if (/\bfanal\b|(?:scan\s+)?cache.*(?:invalid|corrupt|freelist|database|checksum)/i.test(message) && !/vulnerability|trivy-db|java-db|\/db\//i.test(message)) {
    category = "cache";
    retryable = true;
    summary = "検査キャッシュが使用中、または破損しています。キャッシュを分離して再検査します。";
  } else if (/invalid (?:database|db)|database.*corrupt|invalid DB schema|old DB schema|unsupported database schema/i.test(message) || (database && /invalid (?:freelist|page)|checksum mismatch|file size too small|unexpected EOF|invalid character.*metadata|failed to (?:open|parse).*metadata/i.test(message))) {
    category = "database";
    retryable = true;
    summary = "脆弱性データベースが破損しているか、互換性のない形式です。データベースの再取得が必要です。";
  } else if (/cache.*(?:locked|lock|corrupt)|database.*locked|failed to acquire.*lock|cache.*(?:timeout|in use)/i.test(message)) {
    category = "cache";
    retryable = true;
    summary = "検査キャッシュが使用中、または破損しています。キャッシュを分離して再検査します。";
  } else if (/manifest[_ ]unknown|name[_ ]unknown|no matching manifest|unknown tag|image.*not found|repository does not exist|invalid reference format|failed to parse|unable to parse|invalid (?:json|yaml|sbom)|outside the project|artifact.*(?:missing|invalid)/i.test(message)) {
    category = "target";
    summary = "検査対象の指定または依存関係ファイルに問題があります。詳細にあるイメージ名・タグ・ファイルの修正が必要です。";
  } else if (/ENOENT|EACCES|tool is unavailable|executable|command not found|unknown flag|unknown command|not installed|unsupported platform/i.test(message)) {
    category = "tool";
    summary = "検査ツールを起動できないか、必要なオプションに対応していません。実行ファイルとツール設定の修正が必要です。";
  } else if (/timed? out|context deadline exceeded|deadline exceeded/i.test(message)) {
    category = "timeout";
    retryable = true;
    summary = "検査の制限時間を超えました。制限時間を延長して再検査します。";
  } else if (/too many requests|toomanyrequests|429|rate.?limit/i.test(message)) {
    category = "network";
    // Repeated Maven requests can extend its rate-limit block; never loop over them.
    retryable = database;
    summary = "配信元の利用制限により検査データを取得できません。制限解除後の再取得が必要です。";
  } else if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|no such host|network is unreachable|connection (?:reset|refused)|i\/o timeout|TLS handshake timeout|unexpected EOF|HTTP\s*5\d\d|status(?: code)?:?\s*5\d\d|failed to download|fetch failed/i.test(message)) {
    category = "network";
    retryable = true;
    summary = "検査データの取得または接続に失敗しました。接続を再試行します。";
  } else if (/cannot connect to the Docker daemon|docker daemon.*(?:running|unavailable)|socket.*not found|no podman socket|containerd socket/i.test(message)) {
    category = "configuration";
    summary = "コンテナ実行環境に接続できません。Dockerなどの実行環境の起動または接続先の修正が必要です。";
  }
  const details = redactInspectionError(message).trim().slice(-16_000);
  const stableDetails = details.replace(/\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?/g, "[time]").replace(/oneteam-trivy-[^/\s]+/g, "oneteam-trivy-[temporary]");
  return { category, summary, details, retryable, recoveryStatus: retryable ? "failed" : "requires_action", attemptedActions: [],
    fingerprint: createHash("sha256").update(JSON.stringify([command, code, category, stableDetails])).digest("hex").slice(0, 32) };
}

export function isPublicDatabaseFailure(error: unknown): boolean {
  const diagnosis = diagnoseInspectionFailure(error);
  return /(?:vulnerability|java|index)\s+(?:database|db)|(?:database|db)\s+(?:error|download|schema)|trivy(?:-java)?-db/i.test(diagnosis.details);
}
