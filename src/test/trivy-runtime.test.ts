import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTrivy, runInspectionCommand, runTrivy } from "../server/services/trivy-runtime";

const temporaryDirectories: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "oneteam-trivy-runtime-test-"));
  temporaryDirectories.push(root);
  return root;
}
async function fakeTrivy(root: string): Promise<string> {
  const executable = path.join(root, "trivy ; literal executable");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
const ignore = args[args.indexOf("--ignorefile") + 1];
process.stdout.write(JSON.stringify({
  args, cwd: process.cwd(), config, ignore,
  configContent: fs.readFileSync(config, "utf8"), ignoreContent: fs.readFileSync(ignore, "utf8"),
  configMode: fs.statSync(config).mode & 0o777,
  trivyEnvironment: Object.keys(process.env).filter((key) => key.startsWith("TRIVY_"))
}));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated vulnerability inspection runtime", () => {
  it("forces trusted config and ignore files despite repository settings and inherited TRIVY variables", async () => {
    const root = await directory();
    await writeFile(path.join(root, "trivy.yaml"), "ignore-unfixed: true\nseverity: [LOW]\nscanners: []\n");
    await writeFile(path.join(root, ".trivyignore"), "CVE-2026-12345\n");
    await writeFile(path.join(root, ".trivyignore.yaml"), "vulnerabilities:\n  - id: CVE-2026-12345\n");
    const executable = await fakeTrivy(root);
    vi.stubEnv("ONETEAM_TRIVY_COMMAND", executable);
    vi.stubEnv("TRIVY_CONFIG", path.join(root, "trivy.yaml"));
    vi.stubEnv("TRIVY_IGNOREFILE", path.join(root, ".trivyignore"));
    vi.stubEnv("TRIVY_IGNORE_UNFIXED", "true");
    vi.stubEnv("TRIVY_SEVERITY", "LOW");
    vi.stubEnv("TRIVY_VEX", path.join(root, "ignore-vulnerabilities.json"));
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const scan = await runTrivy(["filesystem", "--scanners", "vuln", "--format", "json", "--", root], { cwd: root });
    const output = JSON.parse(scan.stdout) as { args: string[]; cwd: string; config: string; ignore: string; configContent: string; ignoreContent: string; configMode: number; trivyEnvironment: string[] };
    expect(output.args.slice(0, 3)).toEqual(["--config", output.config, "filesystem"]);
    expect(output.args.indexOf("--ignorefile")).toBeLessThan(output.args.indexOf("--"));
    expect(output.args.slice(-2)).toEqual(["--", root]);
    expect(output.configContent).toBe("{}\n");
    expect(output.ignoreContent).toBe("");
    expect(output.configMode).toBe(0o600);
    expect(output.config).not.toBe(path.join(root, "trivy.yaml"));
    expect(output.ignore).not.toBe(path.join(root, ".trivyignore"));
    expect(output.trivyEnvironment).toEqual([]);
    await expect(stat(output.config)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(output.ignore)).rejects.toMatchObject({ code: "ENOENT" });
    expect(network).not.toHaveBeenCalled();
  });

  it("passes shell syntax literally to executables and does not interpolate image references", async () => {
    const root = await directory();
    const sentinel = path.join(root, "shell-must-not-run");
    const image = `registry.example/image:tag; touch '${sentinel}' $(touch '${sentinel}')`;
    vi.stubEnv("ONETEAM_TRIVY_COMMAND", await fakeTrivy(root));
    const scan = await runTrivy(["image", "--scanners", "vuln", "--", image], { cwd: root });
    expect((JSON.parse(scan.stdout) as { args: string[] }).args.at(-1)).toBe(image);
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    const direct = await runInspectionCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", image], { cwd: root });
    expect(JSON.parse(direct.stdout)).toEqual([image]);
  });

  it("rejects relative executable overrides before a download or process invocation", async () => {
    vi.stubEnv("ONETEAM_TRIVY_COMMAND", "./repo-controlled-trivy");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    await expect(ensureTrivy()).rejects.toThrow("absolute executable path");
    expect(network).not.toHaveBeenCalled();
  });

  it("waits for a timed-out child to exit and drain its cleanup output", async () => {
    const root = await directory();
    const pidfile = path.join(root, "child.pid");
    const cleaned = path.join(root, "child.cleaned");
    const script = `const fs = require("node:fs");
      process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(process.argv[2], "cleaned"); process.stdout.write("drained"); process.exit(0); }, 60));
      fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);`;
    await expect(runInspectionCommand(process.execPath, ["-e", script, pidfile, cleaned], { cwd: root, timeoutMs: 200 })).rejects.toThrow("timed out");
    expect(await readFile(cleaned, "utf8")).toBe("cleaned");
    const pid = Number(await readFile(pidfile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("cancels and drains a running child before reporting cancellation", async () => {
    const root = await directory();
    const pidfile = path.join(root, "child.pid");
    const cleaned = path.join(root, "child.cleaned");
    const controller = new AbortController();
    const script = `const fs = require("node:fs");
      process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(process.argv[2], "cleaned"); process.exit(0); }, 60));
      fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);`;
    const child = runInspectionCommand(process.execPath, ["-e", script, pidfile, cleaned], { cwd: root, signal: controller.signal });
    const rejected = expect(child).rejects.toThrow("cancelled");
    await vi.waitFor(async () => expect(Number(await readFile(pidfile, "utf8"))).toBeGreaterThan(0), { timeout: 1_000, interval: 10 });
    controller.abort();
    await rejected;
    expect(await readFile(cleaned, "utf8")).toBe("cleaned");
    const pid = Number(await readFile(pidfile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects cancellation before starting a child", async () => {
    const root = await directory();
    const marker = path.join(root, "must-not-exist");
    const controller = new AbortController();
    controller.abort();
    await expect(runInspectionCommand(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker], { cwd: root, signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("force-kills an uncooperative child and drains it before returning", async () => {
    const root = await directory();
    const pidfile = path.join(root, "stubborn.pid");
    const controller = new AbortController();
    const child = runInspectionCommand(process.execPath, ["-e", `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`, pidfile], { cwd: root, signal: controller.signal });
    const rejected = expect(child).rejects.toThrow("cancelled");
    await vi.waitFor(async () => expect(Number(await readFile(pidfile, "utf8"))).toBeGreaterThan(0), { timeout: 1_000, interval: 10 });
    controller.abort();
    await rejected;
    const pid = Number(await readFile(pidfile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
