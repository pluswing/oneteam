import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { loadConfig } from "../server/config";
import { startOneTeamServer, type StartedOneTeamServer } from "../server/runtime";

let mainWindow: BrowserWindow | null = null;
let server: StartedOneTeamServer | null = null;

process.on("uncaughtException", (error) => {
  debugLog(`uncaughtException: ${formatError(error)}`);
  throw error;
});

process.on("unhandledRejection", (error) => {
  debugLog(`unhandledRejection: ${formatError(error)}`);
});

function distRoot(): string {
  return dirname(__dirname);
}

async function createWindow(): Promise<void> {
  debugLog("createWindow:start");
  configureRuntimeEnvironment();
  const config = loadConfig();
  config.server.host = "127.0.0.1";
  config.server.port = 0;

  server = await startOneTeamServer(config, {
    staticRoot: join(distRoot(), "client"),
    codexLogin: {
      launcher: launchCodexLogin
    }
  });
  debugLog(`server:started:${server.url}`);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "OneTeam",
    backgroundColor: "#f6f8fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    debugLog(`renderer:gone:${details.reason}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (server && url.startsWith(server.url)) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(server.url);
  debugLog("window:loaded");
  mainWindow.on("closed", () => {
    debugLog("window:closed");
    mainWindow = null;
  });
}

app.on("window-all-closed", () => {
  debugLog("app:window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  debugLog("app:activate");
  if (!mainWindow) {
    void createWindow().catch(showStartupError);
  }
});

app.on("before-quit", () => {
  debugLog("app:before-quit");
  server?.stop();
  server = null;
});

function showStartupError(error: unknown): void {
  debugLog(`startup:error:${formatError(error)}`);
  const message = error instanceof Error ? error.message : "Failed to start OneTeam.";
  console.error(error);
  dialog.showErrorBox("OneTeam startup failed", message);
  app.quit();
}

function configureRuntimeEnvironment(): void {
  process.env.ONETEAM_HOME ??= app.getPath("userData");

  if (process.env.ONETEAM_CODEX_COMMAND) {
    return;
  }

  const codex = resolveBundledCodex();
  if (!codex) {
    return;
  }

  process.env.ONETEAM_CODEX_COMMAND = codex.command;
  process.env.CODEX_MANAGED_BY_NPM ??= "1";
  process.env.CODEX_MANAGED_PACKAGE_ROOT ??= join(appPackageRoot(), "node_modules", "@openai", "codex");

  if (codex.pathDir) {
    process.env.PATH = [codex.pathDir, process.env.PATH].filter(Boolean).join(delimiter);
  }
}

function appPackageRoot(): string {
  const appPath = app.getAppPath();
  return appPath.endsWith(".asar") ? appPath.replace(/\.asar$/, ".asar.unpacked") : appPath;
}

function resolveBundledCodex(): { command: string; pathDir?: string } | null {
  const target = codexTarget();
  if (!target) {
    return null;
  }

  const vendorRoot = join(appPackageRoot(), "node_modules", target.packageName, "vendor", target.triple);
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const command = join(vendorRoot, "codex", binaryName);
  if (!existsSync(command)) {
    return null;
  }

  const pathDir = join(vendorRoot, "path");
  return {
    command,
    pathDir: existsSync(pathDir) ? pathDir : undefined
  };
}

function codexTarget(): { packageName: string; triple: string } | null {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin"
    };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin"
    };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl"
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl"
    };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc"
    };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc"
    };
  }

  return null;
}

async function launchCodexLogin(input: { command: string; args: string[] }): Promise<void> {
  if (process.platform === "darwin") {
    const script = [
      [input.command, ...input.args].map(shellQuote).join(" "),
      "printf '\\nCodex login finished. You can close this window.\\n'"
    ].join("; ");
    const child = spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", (error) => debugLog(`codex:login-launch-error:${formatError(error)}`));
    child.unref();
    return;
  }

  const child = spawn(input.command, input.args, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (error) => debugLog(`codex:login-launch-error:${formatError(error)}`));
  child.unref();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function debugLog(message: string): void {
  const logPath = process.env.ONETEAM_ELECTRON_DEBUG_LOG;
  if (!logPath) {
    return;
  }

  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Ignore debug logging failures.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

void app
  .whenReady()
  .then(async () => {
    debugLog("app:ready");
    await createWindow();
  })
  .catch(showStartupError);
