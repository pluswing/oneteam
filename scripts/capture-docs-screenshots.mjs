import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const apiPort = 4680;
const webPort = 4679;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const databasePath = resolve(".tmp/docs-demo/oneteam.db");
const screenshotsDir = resolve("docs/assets/screenshots");
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const tsxBin = resolve(`node_modules/.bin/tsx${binSuffix}`);
const viteBin = resolve(`node_modules/.bin/vite${binSuffix}`);
let shuttingDown = false;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + 120_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${label}: ${lastError}`);
}

function startProcess(command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"]
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (code !== null && code !== 0) {
      console.error(`${command} exited with code ${code}`);
    }
    if (signal) {
      console.error(`${command} exited with signal ${signal}`);
    }
  });

  return child;
}

async function capture(page, name, path, waitFor) {
  await page.goto(`${webBaseUrl}${path}`, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  if (waitFor) {
    await waitFor(page);
  }
  await page.screenshot({
    path: resolve(screenshotsDir, `${name}.png`),
    fullPage: false
  });
  console.log(`Captured ${name}.png`);
}

async function main() {
  mkdirSync(screenshotsDir, { recursive: true });
  execFileSync(tsxBin, ["scripts/docs-demo-data.ts"], { stdio: "inherit" });

  const api = startProcess(tsxBin, ["src/server/index.ts"], {
    ONETEAM_DATABASE_URL: `file:${databasePath}`,
    ONETEAM_AGENT_WORKER: "false",
    PORT: String(apiPort)
  });
  const web = startProcess(viteBin, ["--host", "127.0.0.1", "--port", String(webPort)], {
    VITE_API_TARGET: apiBaseUrl,
    VITE_PORT: String(webPort)
  });

  let browser;
  try {
    await waitForUrl(`${apiBaseUrl}/api/health`, "One Team API");
    await waitForUrl(webBaseUrl, "Vite web server");

    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1
    });

    await capture(page, "overview", "/issues", async (currentPage) => {
      await currentPage.getByRole("heading", { name: "Issues" }).waitFor();
      await currentPage.getByText("Guide missing commands during first setup").waitFor();
    });

    await capture(page, "issue-detail", "/issues/1", async (currentPage) => {
      await currentPage.getByRole("heading", { name: /#1 Guide missing commands/ }).waitFor();
      await currentPage.getByText("For the MVP").waitFor();
    });

    await capture(page, "pull-request-files", "/pulls/1", async (currentPage) => {
      await currentPage.getByRole("heading", { name: /#1 Add a guided empty state/ }).waitFor();
      await currentPage.getByRole("button", { name: "Files changed" }).click();
      await currentPage.locator(".file-row").first().waitFor();
    });

    await capture(page, "agent-job-detail", "/jobs/2", async (currentPage) => {
      await currentPage.getByRole("heading", { name: /#2 implementation/ }).waitFor();
      await currentPage.getByText("Added empty-state copy").waitFor();
    });

    await capture(page, "repository", "/repository", async (currentPage) => {
      await currentPage.getByRole("heading", { name: "Repository" }).waitFor();
      await currentPage.getByText("npm run build").waitFor();
    });
  } finally {
    await browser?.close();
    shuttingDown = true;
    web.kill("SIGTERM");
    api.kill("SIGTERM");
    await delay(500);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
