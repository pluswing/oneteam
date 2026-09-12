import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../server/agents/prompts";
import type { AgentJobDto, ProjectDto } from "../shared/types";
import { setLocale, t } from "../client/i18n";

describe("i18n", () => {
  it("switches UI resources between English and Japanese", () => {
    setLocale("en");
    expect(t("projects.title")).toBe("Choose project");

    setLocale("ja");
    expect(t("projects.title")).toBe("プロジェクトを選択");

    setLocale("en");
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
