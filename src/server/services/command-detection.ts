import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandType } from "../../shared/types";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
type Confidence = "high" | "medium" | "low";

export type DetectedCommand = {
  commandType: CommandType;
  command: string | null;
  detectionSource: string;
  detectionDetails: {
    packageManager: PackageManager;
    confidence: Confidence;
    signals: string[];
    recommendation?: string;
  };
  isRequired: boolean;
  isAvailable: boolean;
};

export type CommandDetectionResult = {
  packageManager: PackageManager;
  commands: DetectedCommand[];
  missingCommands: CommandType[];
};

const commandTypes: CommandType[] = ["install", "dev", "build", "test", "lint"];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(repoPath: string): Promise<Record<string, unknown> | null> {
  const packageJsonPath = join(repoPath, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return null;
  }

  const content = await readFile(packageJsonPath, "utf8");
  return JSON.parse(content) as Record<string, unknown>;
}

async function detectPackageManager(repoPath: string, packageJson: Record<string, unknown> | null): Promise<{
  packageManager: PackageManager;
  signals: string[];
}> {
  const packageManagerField = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : null;
  if (packageManagerField?.startsWith("pnpm@")) {
    return { packageManager: "pnpm", signals: ["package.json:packageManager"] };
  }
  if (packageManagerField?.startsWith("yarn@")) {
    return { packageManager: "yarn", signals: ["package.json:packageManager"] };
  }
  if (packageManagerField?.startsWith("bun@")) {
    return { packageManager: "bun", signals: ["package.json:packageManager"] };
  }
  if (packageManagerField?.startsWith("npm@")) {
    return { packageManager: "npm", signals: ["package.json:packageManager"] };
  }

  const lockSignals: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"]
  ];

  for (const [fileName, manager] of lockSignals) {
    if (await fileExists(join(repoPath, fileName))) {
      return { packageManager: manager, signals: [fileName] };
    }
  }

  if (packageJson) {
    return { packageManager: "npm", signals: ["package.json"] };
  }

  return { packageManager: "unknown", signals: [] };
}

function scriptCommand(packageManager: PackageManager, scriptName: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "npm":
    case "unknown":
      return `npm run ${scriptName}`;
  }
}

function installCommand(packageManager: PackageManager): string | null {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
      return "npm install";
    case "unknown":
      return null;
  }
}

function getScripts(packageJson: Record<string, unknown> | null): Record<string, string> {
  if (!packageJson?.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
    return {};
  }

  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(packageJson.scripts)) {
    if (typeof value === "string") {
      scripts[name] = value;
    }
  }
  return scripts;
}

function findScript(commandType: CommandType, scripts: Record<string, string>): string | null {
  const preferred: Record<CommandType, string[]> = {
    install: [],
    dev: ["dev", "start"],
    build: ["build"],
    test: ["test", "test:unit"],
    lint: ["lint", "check"]
  };

  return preferred[commandType].find((scriptName) => scripts[scriptName]) ?? null;
}

async function recommendationFor(repoPath: string, commandType: CommandType): Promise<string> {
  if (commandType === "build") {
    if (await fileExists(join(repoPath, "vite.config.ts"))) {
      return "Add a build script that runs vite build.";
    }
    if (await fileExists(join(repoPath, "vite.config.js"))) {
      return "Add a build script that runs vite build.";
    }
    if (await fileExists(join(repoPath, "tsconfig.json"))) {
      return "Add a build script that runs tsc or the repository build tool.";
    }
  }

  if (commandType === "test") {
    if (await fileExists(join(repoPath, "vitest.config.ts"))) {
      return "Add a test script that runs vitest run.";
    }
    if (await fileExists(join(repoPath, "jest.config.js"))) {
      return "Add a test script that runs jest.";
    }
  }

  if (commandType === "lint") {
    if (await fileExists(join(repoPath, "eslint.config.js"))) {
      return "Add a lint script that runs eslint .";
    }
    if (await fileExists(join(repoPath, "biome.json"))) {
      return "Add a lint script that runs biome check .";
    }
  }

  if (commandType === "dev") {
    return "Add a dev script that starts the local development server.";
  }

  return `Add a working ${commandType} command for one team automation.`;
}

export async function detectRepositoryCommands(repoPath: string): Promise<CommandDetectionResult> {
  const packageJson = await readPackageJson(repoPath);
  const { packageManager, signals } = await detectPackageManager(repoPath, packageJson);
  const scripts = getScripts(packageJson);
  const commands: DetectedCommand[] = [];

  for (const commandType of commandTypes) {
    if (commandType === "install") {
      const command = installCommand(packageManager);
      commands.push({
        commandType,
        command,
        detectionSource: command ? signals[0] ?? "package_json" : "missing",
        detectionDetails: {
          packageManager,
          confidence: command ? "high" : "low",
          signals
        },
        isRequired: true,
        isAvailable: Boolean(command)
      });
      continue;
    }

    const scriptName = findScript(commandType, scripts);
    if (scriptName) {
      commands.push({
        commandType,
        command: scriptCommand(packageManager, scriptName),
        detectionSource: "package_json",
        detectionDetails: {
          packageManager,
          confidence: "high",
          signals: [`package.json:scripts.${scriptName}`]
        },
        isRequired: true,
        isAvailable: true
      });
      continue;
    }

    commands.push({
      commandType,
      command: null,
      detectionSource: "missing",
      detectionDetails: {
        packageManager,
        confidence: "high",
        signals,
        recommendation: await recommendationFor(repoPath, commandType)
      },
      isRequired: true,
      isAvailable: false
    });
  }

  return {
    packageManager,
    commands,
    missingCommands: commands.filter((command) => !command.isAvailable).map((command) => command.commandType)
  };
}

export function buildMissingCommandIssue(input: {
  commandType: CommandType;
  packageManager: PackageManager;
  signals: string[];
  recommendation?: string;
}): { title: string; body: string } {
  const signals = input.signals.length > 0 ? input.signals.join(", ") : "none";
  return {
    title: `Add ${input.commandType} command`,
    body: [
      "## Background",
      "",
      `one team detected that this repository does not have a \`${input.commandType}\` command.`,
      "",
      "## Detection Result",
      "",
      `- Package manager: \`${input.packageManager}\``,
      `- Detected files: ${signals}`,
      "- Current command: missing",
      "",
      "## Requirement",
      "",
      `Add a working \`${input.commandType}\` command so one team can run automated development, review, and QA workflows.`,
      "",
      "## Suggested Implementation",
      "",
      input.recommendation ?? `Add a working ${input.commandType} command.`,
      "",
      "## Acceptance Criteria",
      "",
      `- \`${input.commandType}\` command is defined in project commands.`,
      "- The command can be executed from the repository root.",
      "- The command result is visible in one team Activity Log."
    ].join("\n")
  };
}
