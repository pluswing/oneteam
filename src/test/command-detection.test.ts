import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMissingCommandIssue, detectRepositoryCommands } from "../server/services/command-detection";

describe("command detection", () => {
  it("detects npm scripts from package.json and package-lock.json", async () => {
    const repo = await mkdtemp(join(tmpdir(), "oneteam-detect-"));
    await writeFile(join(repo, "package-lock.json"), "{}");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          build: "vite build",
          test: "vitest run",
          lint: "eslint ."
        }
      })
    );

    const result = await detectRepositoryCommands(repo);

    expect(result.packageManager).toBe("npm");
    expect(result.missingCommands).toEqual([]);
    expect(result.commands).toMatchObject([
      { commandType: "install", command: "npm install", isAvailable: true },
      { commandType: "dev", command: "npm run dev", isAvailable: true },
      { commandType: "build", command: "npm run build", isAvailable: true },
      { commandType: "test", command: "npm run test", isAvailable: true },
      { commandType: "lint", command: "npm run lint", isAvailable: true }
    ]);
  });

  it("reports missing commands with issue content", async () => {
    const repo = await mkdtemp(join(tmpdir(), "oneteam-missing-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));

    const result = await detectRepositoryCommands(repo);
    const missingBuild = result.commands.find((command) => command.commandType === "build");
    const issue = buildMissingCommandIssue({
      commandType: "build",
      packageManager: result.packageManager,
      signals: missingBuild?.detectionDetails.signals ?? [],
      recommendation: missingBuild?.detectionDetails.recommendation
    });

    expect(result.missingCommands).toContain("build");
    expect(issue.title).toBe("Add build command");
    expect(issue.body).toContain("## Acceptance Criteria");
  });
});
