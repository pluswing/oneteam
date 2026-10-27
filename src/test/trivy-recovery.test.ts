import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrivyRunner, diagnoseInspectionFailure, InspectionError, redactInspectionError, runInspectionCommand, type InspectionRun } from "../server/services/trivy-runtime";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oneteam-trivy-recovery-test-"));
  directories.push(root);
  return root;
}
const failure = (stderr: string) => new InspectionError(`Vulnerability inspection failed (exit 1): ${stderr}`, { command: "trivy", code: 1, stderr });
const success = { stdout: '{"SchemaVersion":2}', stderr: "" };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("automatic inspection recovery", () => {
  it("retries a transient tool download failure before invoking the scanner", async () => {
    const root = await fixture(), wait = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);
    const executable = vi.fn().mockRejectedValueOnce(new Error("Trivy download failed (HTTP 503).")).mockResolvedValue("trivy");
    const command = vi.fn<InspectionRun>().mockResolvedValue(success);
    const result = await createTrivyRunner({ cacheRoot: join(root, "cache"), executable, runCommand: command, wait })(["filesystem", "--", root], { cwd: root });
    expect(executable).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(1_000, undefined);
    expect(result.recovery).toMatchObject({ category: "network", recoveryStatus: "recovered" });
  });

  it("replaces only a corrupted app-owned vulnerability database, then scans using newly downloaded data", async () => {
    const root = await fixture(), cache = join(root, "cache");
    await mkdir(join(cache, "db"), { recursive: true });
    await mkdir(join(cache, "java-db"));
    await writeFile(join(cache, "db", "trivy.db"), "corrupt");
    await writeFile(join(cache, "java-db", "trivy-java.db"), "preserve java database");
    await writeFile(join(root, "package-lock.json"), "preserve project");
    let attempts = 0;
    const command: InspectionRun = async (_command, args) => {
      attempts++;
      expect(args[args.indexOf("--cache-dir") + 1]).toBe(cache);
      if (attempts === 1) throw failure("DB error: failed to open vulnerability database: invalid database");
      await expect(readFile(join(cache, "db", "trivy.db"))).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(join(cache, "db"));
      await writeFile(join(cache, "db", "trivy.db"), "fresh database");
      return success;
    };
    const scan = await createTrivyRunner({ cacheRoot: cache, executable: async () => "trivy", runCommand: command })(["filesystem", "--", root], { cwd: root });
    expect(attempts).toBe(2);
    expect(scan.recovery).toMatchObject({ category: "database", recoveryStatus: "recovered" });
    expect(scan.recovery?.attemptedActions).toHaveLength(1);
    expect(await readFile(join(cache, "db", "trivy.db"), "utf8")).toBe("fresh database");
    expect(await readFile(join(cache, "java-db", "trivy-java.db"), "utf8")).toBe("preserve java database");
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe("preserve project");
    expect(await readdir(cache)).toEqual(expect.not.arrayContaining([expect.stringContaining("recovery-")]));
  });

  it("downloads a public database anonymously without changing private target authentication", async () => {
    const root = await fixture(), calls: string[][] = [];
    vi.stubEnv("GITHUB_TOKEN", "private-user-token");
    vi.stubEnv("DOCKER_CONFIG", join(root, "real-docker-config"));
    let downloaded = false;
    const command: InspectionRun = async (_command, args, options) => {
      calls.push(args);
      if (args.includes("--download-db-only")) {
        expect(options.env?.GITHUB_TOKEN).toBeUndefined();
        expect(options.env?.DOCKER_CONFIG).not.toBe(process.env.DOCKER_CONFIG);
        expect(JSON.parse(await readFile(join(options.env!.DOCKER_CONFIG!, "config.json"), "utf8"))).toEqual({ auths: {} });
        downloaded = true;
        return { stdout: "", stderr: "" };
      }
      expect(options.env?.GITHUB_TOKEN).toBe("private-user-token");
      expect(options.env?.DOCKER_CONFIG).toBe(process.env.DOCKER_CONFIG);
      if (!downloaded) throw failure("failed to download vulnerability DB: ghcr.io/aquasecurity/trivy-db: DENIED: denied");
      return success;
    };
    const scan = await createTrivyRunner({ cacheRoot: join(root, "cache"), executable: async () => "trivy", runCommand: command })(["image", "--", "private.example/project:tag"], { cwd: root });
    expect(calls).toHaveLength(3);
    expect(scan.recovery).toMatchObject({ category: "authentication", recoveryStatus: "recovered" });
    expect(calls.flat()).not.toContain("--skip-db-update");
    expect(calls.flat()).not.toContain("--insecure");
    expect(process.env.GITHUB_TOKEN).toBe("private-user-token");
  });

  it("bypasses a locked scan cache with the memory backend instead of deleting its lock", async () => {
    const root = await fixture(), cache = join(root, "cache");
    await mkdir(join(cache, "fanal"), { recursive: true });
    await writeFile(join(cache, "fanal", "fanal.db"), "live lock");
    const command = vi.fn<InspectionRun>().mockImplementation(async (_command, args) => {
      if (!args.includes("--cache-backend")) throw failure("cache may be in use: failed to acquire cache lock");
      expect(args[args.indexOf("--cache-backend") + 1]).toBe("memory");
      expect(await readFile(join(cache, "fanal", "fanal.db"), "utf8")).toBe("live lock");
      return success;
    });
    const scan = await createTrivyRunner({ cacheRoot: cache, executable: async () => "trivy", runCommand: command })(["image", "--", "image:tag"], { cwd: root });
    expect(scan.recovery).toMatchObject({ category: "cache", recoveryStatus: "recovered" });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("backs off transient failures and stops after three failed scans with the actual cause", async () => {
    const root = await fixture(), wait = vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>(async () => undefined);
    const command = vi.fn<InspectionRun>().mockRejectedValue(failure("DB error: failed to download vulnerability DB: connection reset by peer"));
    const run = createTrivyRunner({ cacheRoot: join(root, "cache"), executable: async () => "trivy", runCommand: command, wait });
    let thrown: unknown;
    try { await run(["filesystem", "--", root], { cwd: root }); } catch (error) { thrown = error; }
    expect(command).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map((call) => call[0])).toEqual([1_000, 3_000]);
    expect(thrown).toBeInstanceOf(InspectionError);
    expect(diagnoseInspectionFailure(thrown)).toMatchObject({ category: "network", recoveryStatus: "failed", details: expect.stringContaining("connection reset by peer") });
    expect(diagnoseInspectionFailure(thrown).attemptedActions).toHaveLength(2);
  });

  it("extends a timed-out scan and its process deadline for the retry", async () => {
    const root = await fixture();
    const command = vi.fn<InspectionRun>().mockImplementation(async (_command, args, options) => {
      if (args[args.indexOf("--timeout") + 1] === "4m") throw failure("analyze error: context deadline exceeded");
      expect(args[args.indexOf("--timeout") + 1]).toBe("8m");
      expect(options.timeoutMs).toBe(9 * 60_000);
      return success;
    });
    const scan = await createTrivyRunner({ cacheRoot: join(root, "cache"), executable: async () => "trivy", runCommand: command })(["filesystem", "--", root], { cwd: root });
    expect(command).toHaveBeenCalledTimes(2);
    expect(scan.recovery).toMatchObject({ category: "timeout", recoveryStatus: "recovered" });
  });

  it.each([
    ["target", "remote error: MANIFEST_UNKNOWN: unknown tag=bad"],
    ["authentication", "GET private.example/image: UNAUTHORIZED: authentication required"],
    ["configuration", "x509: certificate signed by unknown authority"],
    ["cache", "no space left on device"],
    ["network", "Maven Central 429 Too Many Requests"],
  ])("does not repeatedly retry a %s failure requiring outside changes", async (category, stderr) => {
    const root = await fixture(), command = vi.fn<InspectionRun>().mockRejectedValue(failure(stderr));
    const run = createTrivyRunner({ cacheRoot: join(root, "cache"), executable: async () => "trivy", runCommand: command });
    let thrown: unknown;
    try { await run(["image", "--", "private.example/image:bad"], { cwd: root }); } catch (error) { thrown = error; }
    expect(command).toHaveBeenCalledTimes(1);
    expect(diagnoseInspectionFailure(thrown)).toMatchObject({ category, recoveryStatus: "requires_action", retryable: false });
  });

  it("refuses to reset a symlinked database that points outside the app cache", async () => {
    const root = await fixture(), cache = join(root, "cache"), outside = join(root, "outside");
    await mkdir(cache); await mkdir(outside); await writeFile(join(outside, "keep"), "user data");
    await symlink(outside, join(cache, "db"));
    const command = vi.fn<InspectionRun>().mockRejectedValue(failure("DB error: invalid database"));
    await expect(createTrivyRunner({ cacheRoot: cache, executable: async () => "trivy", runCommand: command })(["filesystem", "--", root], { cwd: root })).rejects.toMatchObject({ diagnosis: { recoveryStatus: "failed" } });
    expect(command).toHaveBeenCalledTimes(1);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("user data");
  });

  it("does not start a retry after cancellation during backoff", async () => {
    const root = await fixture(), controller = new AbortController();
    const command = vi.fn<InspectionRun>().mockRejectedValue(failure("connection reset by peer"));
    const wait = vi.fn(async () => { controller.abort(); throw new Error("Vulnerability inspection cancelled."); });
    const run = createTrivyRunner({ cacheRoot: join(root, "cache"), executable: async () => "trivy", runCommand: command, wait });
    await expect(run(["filesystem", "--", root], { cwd: root, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("retains nonzero process diagnostics and redacts credential formats before persistence", async () => {
    const root = await fixture();
    const stderr = 'FATAL DB error: GET https://user:private-password@example.com/v2?token=query-secret\nAuthorization: Bearer bearer-secret\n{"password": "json-secret"}\nconnection reset by peer';
    let thrown: unknown;
    try { await runInspectionCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`], { cwd: root }); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 1, command: "node" });
    const diagnosis = diagnoseInspectionFailure(thrown);
    expect(diagnosis.category).toBe("network");
    expect(diagnosis.details).toContain("connection reset by peer");
    expect(JSON.stringify(thrown)).not.toMatch(/private-password|query-secret|bearer-secret|json-secret/);
    expect(redactInspectionError('api_key="api secret" Basic base64-secret')).not.toContain("api secret");
    const sanitized = redactInspectionError("DENIED: credential-secret-token https://secret@example.com ghp_abcdefghijklmnop");
    expect(sanitized).toContain("DENIED");
    expect(sanitized).not.toMatch(/credential-secret-token|secret@|ghp_abcdefghijklmnop/);
  });
});
