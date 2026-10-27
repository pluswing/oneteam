import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ScanFailureDiagnosis } from "../../shared/vulnerabilities";
import { diagnoseInspectionFailure, InspectionError, isPublicDatabaseFailure, redactInspectionError } from "./inspection-failure";
export { diagnoseInspectionFailure, InspectionError, redactInspectionError } from "./inspection-failure";

export type TrivyRun = (args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; recovery?: ScanFailureDiagnosis }>;
export type InspectionRun = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
export const TRIVY_VERSION = "0.76.0";
// SHA-256 pins from the immutable official v0.76.0 release, checked 2026-10-23.
const releases: Record<string, { asset: string; sha256: string }> = {
  "darwin-arm64": { asset: "macOS-ARM64", sha256: "e7ec0d21fe842553f59af99aba2efbcc822369fbaed27019c575408b6d135fce" },
  "darwin-x64": { asset: "macOS-64bit", sha256: "89563d4d495cf4ef06a0d1950f8710b124e9f7bd2615ec6c47b03673f4ad45a2" },
  "linux-arm64": { asset: "Linux-ARM64", sha256: "aab21e677a7b7071fc79f1711480840754c18a1b9d9cefa7ccd06af63a0e8f4c" },
  "linux-x64": { asset: "Linux-64bit", sha256: "e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7" }
};
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const toolRoot = () => join(homedir(), ".oneteam", "tools", `trivy-${TRIVY_VERSION}-${process.platform}-${process.arch}`);
let installing: Promise<string> | null = null;
let running: Promise<unknown> = Promise.resolve();

/** No shell, bounded output/deadline, cancellation kills and drains the actual child. */
export const runInspectionCommand: InspectionRun = async (command, args, options) => {
  if (options.signal?.aborted) throw new Error("Vulnerability inspection cancelled.");
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputSize = 0;
    let failure: Error | null = null;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* The process or its group has already exited. */ }
    };
    const stop = (message: string) => {
      failure ??= new InspectionError(message, { command });
      kill("SIGTERM");
      forceKill ??= setTimeout(() => kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => stop("Vulnerability inspection timed out."), options.timeoutMs ?? 5 * 60_000);
    timeout.unref();
    const abort = () => stop("Vulnerability inspection cancelled.");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 32 * 1024 * 1024) stop("Vulnerability inspection output exceeds the size limit.");
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    const cleanup = () => { clearTimeout(timeout); clearTimeout(forceKill); options.signal?.removeEventListener("abort", abort); };
    child.once("error", (error: NodeJS.ErrnoException) => { cleanup(); reject(new InspectionError(`Vulnerability inspection tool is unavailable: ${error.message}`, { command, code: error.code })); });
    child.once("close", (code) => {
      cleanup();
      const out = Buffer.concat(stdout).toString("utf8"), err = Buffer.concat(stderr).toString("utf8");
      if (failure) reject(failure);
      else if (code !== 0) reject(new InspectionError(`Vulnerability inspection failed (exit ${code ?? "unknown"}): ${redactInspectionError(err.slice(-16_000))}`, { command, code, stderr: err }));
      else resolve({ stdout: out, stderr: err });
    });
  });
};

export async function ensureTrivy(signal?: AbortSignal): Promise<string> {
  const override = process.env.ONETEAM_TRIVY_COMMAND;
  if (override) {
    if (!isAbsolute(override)) throw new Error("ONETEAM_TRIVY_COMMAND must be an absolute executable path.");
    return override;
  }
  if (!installing) installing = provisionTrivy(signal).catch((error) => { installing = null; throw error; });
  return installing;
}

async function provisionTrivy(signal?: AbortSignal): Promise<string> {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release) throw new Error("Automatic Trivy setup is unavailable on this platform. Set ONETEAM_TRIVY_COMMAND to an installed Trivy executable.");
  const root = toolRoot(), executable = join(root, "trivy");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error("The scanner tool directory must not be a symlink.");
  try {
    const info = await lstat(executable);
    const receipt = await readFile(join(root, "binary.sha256"), "utf8");
    if (info.isFile() && !info.isSymbolicLink() && digest(await readFile(executable)) === receipt.trim()) return executable;
  } catch { /* First use or interrupted installation: install the pinned binary again. */ }
  const temporary = await mkdtemp(join(root, "install-"));
  try {
    const filename = `trivy_${TRIVY_VERSION}_${release.asset}.tar.gz`;
    const response = await fetch(`https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${filename}`, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)])
    });
    if (!response.ok || !response.body) throw new Error(`Trivy download failed (HTTP ${response.status}).`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > 160 * 1024 * 1024) { throw new Error("Trivy download exceeds the size limit."); }
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (digest(archive) !== release.sha256) throw new Error("Trivy download failed SHA-256 verification.");
    const archivePath = join(temporary, "trivy.tar.gz");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    // Extract only the expected executable, never archive paths or installation scripts.
    await runInspectionCommand("tar", ["-xzf", archivePath, "-C", temporary, "trivy"], { cwd: temporary, signal, timeoutMs: 30_000 });
    const binary = join(temporary, "trivy");
    const stat = await lstat(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 250 * 1024 * 1024) throw new Error("Trivy archive does not contain a valid executable.");
    const checksum = digest(await readFile(binary));
    await chmod(binary, 0o700);
    await rename(binary, executable);
    await writeFile(join(root, "binary.sha256"), checksum, { mode: 0o600 });
    return executable;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

type TrivyRuntimeOptions = {
  runCommand?: InspectionRun;
  executable?: (signal?: AbortSignal) => Promise<string>;
  cacheRoot?: string;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Vulnerability inspection cancelled.");
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Vulnerability inspection cancelled.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The scanner cache directory must be a real directory, not a symlink.");
}

/** Dependency injection lets recovery tests prove that the next scan uses the repaired state. */
export function createTrivyRunner(runtime: TrivyRuntimeOptions = {}): TrivyRun {
  const run = runtime.runCommand ?? runInspectionCommand;
  const getExecutable = runtime.executable ?? ensureTrivy;
  const wait = runtime.wait ?? waitForRetry;
  return async (args, options) => {
  const task = running.catch(() => undefined).then(async () => {
    if (options.signal?.aborted) throw new Error("Vulnerability inspection cancelled.");
    let executable: string;
    let provisioningDiagnosis: ScanFailureDiagnosis | undefined;
    const provisioningActions: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try { executable = await getExecutable(options.signal); break; }
      catch (error) {
        if (options.signal?.aborted) throw error;
        const diagnosis = diagnoseInspectionFailure(error);
        provisioningDiagnosis ??= diagnosis;
        if (diagnosis.category !== "network" || !diagnosis.retryable || attempt >= 2) {
          throw new InspectionError(error instanceof Error ? error.message : String(error), { command: "trivy", diagnosis: { ...diagnosis,
            attemptedActions: provisioningActions, recoveryStatus: provisioningActions.length ? "failed" : "requires_action" } });
        }
        provisioningActions.push("一時的な接続障害に対して再試行しました。");
        await wait(attempt === 0 ? 1_000 : 3_000, options.signal);
      }
    }
    const temporary = await mkdtemp(join(tmpdir(), "oneteam-trivy-"));
    let quarantined: string | undefined;
    try {
      const config = join(temporary, "config.yaml"), ignorefile = join(temporary, "ignore");
      await writeFile(config, "{}\n", { mode: 0o600 }); await writeFile(ignorefile, "", { mode: 0o600 });
      const cache = runtime.cacheRoot ?? join(homedir(), ".oneteam", "cache", "trivy");
      if (!runtime.cacheRoot) {
        await privateDirectory(join(homedir(), ".oneteam"));
        await privateDirectory(join(homedir(), ".oneteam", "cache"));
      }
      await privateDirectory(cache);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TRIVY_")));
      const positional = args.indexOf("--");
      const index = positional < 0 ? args.length : positional;
      let timeout = "4m", memoryCache = false;
      let initialDiagnosis: ScanFailureDiagnosis | undefined = provisioningDiagnosis;
      const actions: string[] = [...provisioningActions];
      const flags = () => ["--ignorefile", ignorefile, "--cache-dir", cache, "--timeout", timeout, "--no-progress", "--skip-version-check", "--disable-telemetry", ...(memoryCache ? ["--cache-backend", "memory"] : [])];
      const invoke = () => run(executable, ["--config", config, ...args.slice(0, index), ...flags(), ...args.slice(index)], { ...options, env, timeoutMs: timeout === "8m" ? 9 * 60_000 : 5 * 60_000 });
      for (let attempt = 0; ; attempt++) {
        try {
          const output = await invoke();
          return initialDiagnosis ? { ...output, recovery: { ...initialDiagnosis, recoveryStatus: "recovered" as const, attemptedActions: actions } } : output;
        } catch (error) {
          if (options.signal?.aborted || /cancelled|canceled|aborted/i.test(error instanceof Error ? error.message : "")) throw error;
          const current = diagnoseInspectionFailure(error);
          initialDiagnosis ??= current;
          const fail = (cause: unknown): never => {
            const latest = diagnoseInspectionFailure(cause);
            const diagnosis: ScanFailureDiagnosis = { ...latest, recoveryStatus: actions.length || initialDiagnosis!.retryable || latest.retryable ? "failed" : "requires_action", attemptedActions: [...actions],
              details: initialDiagnosis!.details === latest.details ? latest.details : `${initialDiagnosis!.details}\n\n再試行の結果:\n${latest.details}` };
            throw new InspectionError(error instanceof Error ? error.message : String(error), { command: executable,
              code: error instanceof InspectionError ? error.code : null, stderr: diagnosis.details, diagnosis });
          };
          if (attempt >= 2) fail(error);
          try {
            if (current.category === "authentication" && isPublicDatabaseFailure(error) && !actions.some((action) => action.startsWith("公開脆弱性"))) {
              const dockerConfig = join(temporary, "anonymous-docker");
              await mkdir(dockerConfig, { mode: 0o700 });
              await writeFile(join(dockerConfig, "config.json"), "{\"auths\":{}}\n", { mode: 0o600 });
              const anonymousEnv: NodeJS.ProcessEnv = { ...env, DOCKER_CONFIG: dockerConfig };
              delete anonymousEnv.GITHUB_TOKEN; delete anonymousEnv.GH_TOKEN;
              const java = /java[- ](?:db|index)|trivy-java-db/i.test(current.details);
              actions.push("公開脆弱性データベースを認証情報なしで再取得しました。");
              await run(executable, ["--config", config, "image", java ? "--download-java-db-only" : "--download-db-only", ...flags()], { ...options, env: anonymousEnv, timeoutMs: 5 * 60_000 });
            } else if (current.category === "database" && current.retryable && !quarantined) {
              // Only our reproducible databases are replaced. Never remove a live scan-cache lock.
              await privateDirectory(cache);
              quarantined = await mkdtemp(join(cache, ".oneteam-recovery-"));
              const database = /java[- ](?:db|index)|trivy-java-db/i.test(current.details) ? "java-db" : "db";
              const source = join(cache, database);
              try {
                const info = await lstat(source);
                if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The scanner database directory must not be a symlink or a file.");
                await rename(source, join(quarantined, database));
              } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
              actions.push("破損したアプリ専用データベースを再作成しました。");
            } else if (current.category === "cache" && current.retryable && !memoryCache) {
              memoryCache = true;
              actions.push("検査キャッシュをメモリ上に分離しました。");
            } else if (current.category === "timeout" && timeout !== "8m") {
              timeout = "8m";
              actions.push("検査の制限時間を8分に延長しました。");
            } else if (current.category === "network" && current.retryable) {
              actions.push("一時的な接続障害に対して再試行しました。");
              await wait(attempt === 0 ? 1_000 : 3_000, options.signal);
            } else if (current.category === "tool" && !runtime.executable && !process.env.ONETEAM_TRIVY_COMMAND && attempt === 0) {
              installing = null;
              executable = await ensureTrivy(options.signal);
              await chmod(executable, 0o700);
              actions.push("アプリ専用の検査ツールを再検証・再配置しました。");
            } else fail(error);
          } catch (recoveryError) { if (options.signal?.aborted) throw recoveryError; fail(recoveryError); }
        }
      }
    } finally {
      if (quarantined) await rm(quarantined, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });
  running = task;
  return task;
  };
}

/** Serializes the shared vulnerability DB cache and isolates configuration from the repository. */
export const runTrivy: TrivyRun = createTrivyRunner();
