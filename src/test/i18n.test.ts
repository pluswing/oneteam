import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../server/agents/prompts";
import type { AgentJobDto, ProjectDto } from "../shared/types";
import { formatDisplayValue } from "../client/formatters";
import { formatJobTarget } from "../client/agent-status";
import { setLocale, t } from "../client/i18n";

describe("i18n", () => {
  it("switches UI resources between English and Japanese", () => {
    setLocale("en");
    expect(t("projects.title")).toBe("Choose project");

    setLocale("ja");
    expect(t("projects.title")).toBe("プロジェクトを選択");

    setLocale("en");
  });

  it("localizes navigation, task states and roles while preserving identifiers", () => {
    setLocale("ja");
    expect(t("nav.issues")).toBe("課題");
    expect(t("nav.pullRequests")).toBe("プルリクエスト");
    expect(t("nav.agentRuns")).toBe("ジョブ");
    expect(t("issues.triageConvert")).toBe("課題に変換");
    expect(t("development.empty")).toContain("課題");
    expect(formatDisplayValue("implementation")).toBe("実装");
    expect(formatDisplayValue("waiting_human")).toBe("確認待ち");
    expect(formatDisplayValue("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(formatJobTarget({ ...fakeJob, targetType: "issue", targetId: 42 })).toBe("課題 #42");
    setLocale("en");
    expect(formatDisplayValue("implementation")).toBe("implementation");
    expect(formatJobTarget({ ...fakeJob, targetType: "pull_request", targetId: 42 })).toBe("pull_request #42");
  });

  it("adds the project output language to agent prompts", () => {
    const japanesePrompt = buildAgentPrompt(fakeJob, {
      project: { ...fakeProject, locale: "ja" },
      target: { ...fakeProject, locale: "ja" },
      objective: null,
      comments: [],
      commands: [],
      knowledge: []
    });
    const englishPrompt = buildAgentPrompt(fakeJob, {
      project: { ...fakeProject, locale: "en" },
      target: { ...fakeProject, locale: "en" },
      objective: null,
      comments: [],
      commands: [],
      knowledge: []
    });

    expect(japanesePrompt).toContain("Write all user-visible text in Japanese.");
    expect(englishPrompt).toContain("Write all user-visible text in English.");
    expect(japanesePrompt).toContain("Keep JSON keys, enum values, system labels");
  });
});

const fakeProject: ProjectDto = {
  id: "project_1",
  name: "Example",
  repoPath: "/tmp/example",
  defaultBranch: "main",
  locale: "en",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const fakeJob: AgentJobDto = {
  id: 1,
  projectId: "project_1",
  aiProvider: "codex",
  aiModel: null,
  agentType: "requirements",
  targetType: "project",
  targetId: 1,
  status: "queued",
  triggerType: "manual",
  parentJobId: null,
  input: {},
  output: null,
  error: null,
  attempt: 1,
  lockKey: null,
  waitReason: null,
  waitMetadata: null,
  nextRetryAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null
};
