import { expect, test } from "@playwright/test";
import { createApp } from "../src/server/app";
import type { CodexRpc } from "../src/server/agents/codex-rpc";
import { ChatService } from "../src/server/services/chat-service";
import { developmentFixture } from "../src/test/development-fixture";
import { expectScreenContrast } from "./accessibility";

test("chat navigation, real Issue operations, isolated histories, settings and stop", async ({ page }) => {
  const fixture = await developmentFixture();
  const { project, repos } = fixture;
  const base = `/api/projects/${project.id}`;
  const chats = new ChatService(repos, { command: "unused",
    createRpc: () => ({ async initialize() {}, async closeAndDrain() {}, async request() { return { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: false, isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) }], nextCursor: null }; } }) as unknown as CodexRpc,
    runner: async (input) => {
      await input.onThread(`thread-${input.chat.id}`); input.onModel("gpt-6.1-sol");
      if (input.text.includes("Wait")) {
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Stopped");
      }
      if (input.text.includes("create an Issue")) {
        input.onText("Creating the requested Issue…");
        await input.tool("oneteam_request", { method: "POST", path: `${base}/issues`, body: { title: "Issue from chat", body: "Acceptance criteria from our conversation" } }, "create-issue");
        return { text: "Created [Issue #1](/issues/1). Its development Loop is queued.", model: "gpt-6.1-sol" };
      }
      return { text: input.history.some((message) => message.content.includes("Remember alpha")) ? "The marker for this conversation is alpha." : "This conversation has no marker.", model: "gpt-6.1-sol" };
    }
  });
  const app = createApp({ repos, chats });
  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === "/api/codex/status") { await route.fulfill({ json: { status: "connected" } }); return; }
      const response = await app.request(`${url.pathname}${url.search}`, { method: request.method(), headers: { "Content-Type": "application/json" },
        ...(request.postData() ? { body: request.postData()! } : {}) });
      await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
    });
    await page.goto("/chats");
    await expect(page.getByRole("navigation", { name: "Repository navigation" }).getByRole("button").first()).toHaveText("Chat");
    await expect(page.getByRole("heading", { name: "What would you like to work on?" })).toBeVisible();
    await expectScreenContrast(page, "empty chat");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Remember alpha and create an Issue for the agreed change.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-message-assistant")).toContainText("Created Issue #1");
    await expect(page.locator(".chat-operation")).toContainText("Create Issue");
    expect((await repos.issues.list({ projectId: project.id })).items).toHaveLength(1);
    const firstId = page.url().split("/").at(-1)!;
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.locator(".chat-messages")).not.toContainText("Remember alpha");
    await composer.fill("What is my marker?"); await composer.press("Enter");
    await expect(page.locator(".chat-message-assistant")).toHaveText(/This conversation has no marker/);
    await page.locator(".chat-session").filter({ hasText: "Remember alpha" }).click();
    await expect(page).toHaveURL(new RegExp(firstId));
    await composer.fill("What is my marker?"); await composer.press("Enter");
    await expect(page.locator(".chat-message-assistant").last()).toContainText("The marker for this conversation is alpha.");
    await page.reload();
    await expect(page.locator(".chat-message-assistant").last()).toContainText("The marker for this conversation is alpha.");
    await page.getByRole("combobox", { name: "Chat model", exact: true }).selectOption("gpt-6.1-sol");
    await page.getByRole("combobox", { name: "Chat reasoning effort" }).selectOption("high");
    await expect.poll(async () => (await repos.chats.get(project.id, firstId))?.effort).toBe("high");
    await page.getByRole("button", { name: "Rename chat" }).click();
    await page.getByRole("textbox", { name: "Chat title" }).fill("Feature planning");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".chat-heading h2")).toHaveText("Feature planning");
    await expectScreenContrast(page, "chat with operations");
    await page.screenshot({ path: ".tmp/chats-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".tmp/chats-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await composer.fill("Wait until I stop this response"); await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator(".chat-message-note")).toContainText("Response stopped");
    expect((await repos.chats.messages(project.id, firstId)).filter((message) => message.role === "user")).toHaveLength(3);
  } finally { await chats.stopAndDrain(); await fixture.cleanup(); }
});
