import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveStatic } from "@hono/node-server/serve-static";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AiSettingsDto } from "../shared/ai-providers";
import { aiProviders, normalizeAiSettings, roleAiAgentTypes } from "../shared/ai-providers";
import type {
  AgentJobDto,
  AgentJobStatus,
  AgentType,
  IssueDto,
  IssueStatus,
  KnownRepositoryDto,
  ProjectDto,
  ProjectSettingsDto,
  PullRequestDto,
  PullRequestStatus
} from "../shared/types";
import { supportedLocales } from "../shared/locales";
import { issueWorkflowLabelNames, workflowLabelNames } from "../shared/workflow-labels";
import type { Repositories } from "./db/repositories";
import { listSelectableRepositories, repositoryDatabaseUrl } from "./config";
import { resolveAgentJobLockKey } from "./services/agent-job-locks";
import { buildMissingCommandIssue, detectRepositoryCommands } from "./services/command-detection";
import {
  detectMergeConflicts,
  getBranches,
  getCommitCount,
  getCommits,
  getDiffFilePatch,
  getDiffFiles,
  getDiffWithPatches,
  getRepositoryStatus,
  getRevisionHash
} from "./services/git-service";
import { ensureKnowledgeFiles, listKnowledgeFiles, writeKnowledgeFile } from "./services/knowledge-files";
import { runLabelAutomation } from "./services/label-automation";
import { startLoopRun } from "./services/loop-runner";
import { ensureObjectiveForTarget } from "./services/objective-runs";
import { cancelObjective, pauseObjective, resumeObjective } from "./services/objective-control";
import { readAutomationSettings, saveAutomationSettings } from "./services/automation-settings";
import { mergePullRequest } from "./services/pull-request-merge";
import { collectPullRequestFindings } from "./services/pull-request-findings";
import {
  collectPullRequestLineComments,
  diffPatchContainsLine,
  lineCommentMetadata,
  toPullRequestLineComment
} from "./services/pull-request-line-comments";
import { recordProviderWaitCanceled, resumeProviderWait } from "./services/provider-wait";
import { recordIssueReopened, reopenedIssueWorkflowLabel } from "./services/issue-reopen";
import { recordGoalContractChange } from "./services/goal-contract-change";
import { agentJobReferencesArtifact, readStoredEvidenceArtifact } from "./services/evidence-artifacts";

const execFileAsync = promisify(execFile);

export type AppDependencies = {
  ai?: ProjectSettingsDto["ai"];
  repos: Repositories;
  runtime?: ProjectSettingsDto["runtime"];
  staticRoot?: string;
  switchDatabaseForRepository?: (repoPath: string, name?: string) => Promise<KnownRepositoryDto | null>;
};

const createProjectSchema = z.object({
  mode: z.enum(["import", "create"]).default("import"),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  locale: z.enum(supportedLocales).default("en"),
  aiProvider: z.enum(aiProviders).default("codex")
});

const switchRepositorySchema = z.object({
  repoPath: z.string().min(1),
  name: z.string().optional()
});

const createIssueSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  labelIds: z.array(z.number()).optional()
});

const updateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.enum(["open", "closed"]).optional(),
  labelIds: z.array(z.number()).optional(),
  goalChangeReason: z.string().trim().min(1).optional()
});

const createCommentSchema = z.object({
  body: z.string().min(1)
});

const updateCommentSchema = z.object({
  body: z.string().refine((value) => value.trim().length > 0),
  expectedUpdatedAt: z.string().min(1)
});

const createPullRequestLineCommentSchema = z.object({
  body: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["L", "R"]),
  sourceCommit: z.string().min(1),
  targetCommit: z.string().min(1)
});

const createPullRequestSchema = z.object({
  issueId: z.number().nullable().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  labelIds: z.array(z.number()).optional()
});

const updatePullRequestSchema = createPullRequestSchema
  .partial()
  .extend({
    status: z.enum(["open", "closed", "merged"]).optional()
  });

const createAgentJobSchema = z.object({
  agentType: z.enum(["requirements", "implementation", "review", "fix", "qa", "verifier", "command_detection"]),
  targetType: z.enum(["issue", "pull_request", "project"]),
  targetId: z.number(),
  triggerType: z.string().default("manual"),
  input: z.record(z.string(), z.unknown()).optional()
});

const resumeProviderWaitSchema = z.object({
  aiProvider: z.enum(aiProviders).optional()
});

const detectCommandsSchema = z.object({
  createIssuesForMissingCommands: z.boolean().default(true)
});

const roleAiOverrideSchema = z.object({
  provider: z.enum(aiProviders).nullable().optional(),
  model: z.string().nullable().optional()
}).strict();

const updateProjectSettingsSchema = z
  .object({
    locale: z.enum(supportedLocales),
    ai: z
      .object({
        provider: z.enum(aiProviders).optional(),
        roleOverrides: z
          .object({
            implementation: roleAiOverrideSchema.optional(),
            review: roleAiOverrideSchema.optional(),
            qa: roleAiOverrideSchema.optional(),
            verifier: roleAiOverrideSchema.optional()
          })
          .strict()
          .optional(),
        claudeCode: z
          .object({
            command: z.string().min(1).optional(),
            model: z.string().nullable().optional(),
            permissionMode: z.enum(["default", "auto", "dontAsk", "bypassPermissions"]).optional(),
            maxTurns: z.number().int().positive().nullable().optional()
          })
          .strict()
          .optional(),
        lmStudio: z
          .object({
            baseUrl: z.string().url().optional(),
            model: z.string().nullable().optional(),
            maxToolRounds: z.number().int().positive().optional(),
            temperature: z.number().nullable().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    automation: z
      .object({
        autoMergeEnabled: z.boolean().optional(),
        autoMergeTargetBranches: z.array(z.string().min(1)).optional(),
        autoMergeStrategy: z.enum(["merge", "squash"]).optional(),
        autoMergeRiskThreshold: z.enum(["medium", "high", "none"]).optional(),
        objectiveTokenBudget: z.number().int().positive().nullable().optional(),
        objectiveCostBudgetUsd: z.number().positive().nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict();

const createLoopSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  triggerType: z.string().default("manual"),
  cadence: z.string().nullable().optional(),
  targetScope: z.string().default("project"),
  status: z.enum(["enabled", "disabled"]).default("enabled"),
  maxRounds: z.number().int().positive().default(3),
  timeBudgetMinutes: z.number().int().positive().nullable().optional(),
  costBudget: z.number().int().positive().nullable().optional(),
  stopCondition: z.record(z.string(), z.unknown()).nullable().optional(),
  riskPolicy: z.record(z.string(), z.unknown()).nullable().optional()
});

const updateLoopSchema = createLoopSchema.partial();

const startLoopRunSchema = z.object({
  agentType: z.enum(["requirements", "implementation", "review", "fix", "qa", "verifier", "command_detection"]),
  targetType: z.enum(["issue", "pull_request", "project"]),
  targetId: z.number(),
  triggerType: z.string().default("manual"),
  input: z.record(z.string(), z.unknown()).optional()
});

const createLoopMemorySchema = z.object({
  loopId: z.number().nullable().optional(),
  loopRunId: z.number().nullable().optional(),
  sourceType: z.enum(["manual", "loop_run", "agent_job", "triage"]).default("manual"),
  sourceId: z.number().nullable().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  tags: z.array(z.string()).optional()
});

const createTriageItemSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.number().nullable().optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  priority: z.string().default("normal"),
  metadata: z.record(z.string(), z.unknown()).nullable().optional()
});

const updateTriageItemSchema = z.object({
  status: z.enum(["open", "converted", "ignored"]).optional(),
  issueId: z.number().nullable().optional()
});

const updateKnowledgeFileSchema = z.object({
  body: z.string()
});

function notFound(message: string): never {
  throw new HTTPException(404, { message });
}

function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

function forbidden(message: string): never {
  throw new HTTPException(403, { message });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function pageParams(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);
  return { limit, offset };
}

async function enrichWithLatestAgentStop<T extends IssueDto | PullRequestDto>(
  repos: Repositories,
  projectId: string,
  targetType: "issue" | "pull_request",
  items: T[]
): Promise<T[]> {
  return Promise.all(
    items.map(async (item) => {
      const jobs = await repos.agentJobs.list({ projectId, targetType, targetId: item.id });
      const latest = jobs[0];
      const stopReason = latest?.output && typeof latest.output.stopReason === "string" ? latest.output.stopReason : null;
      return {
        ...item,
        lastAgentStatus: latest?.status ?? null,
        lastAgentStopReason: stopReason
      };
    })
  );
}

async function getProjectOr404(repos: Repositories, projectId: string) {
  const project = await repos.projects.get(projectId);
  if (!project) {
    notFound("Project was not found.");
  }
  return project;
}

async function enrichPullRequestWithGitStats(project: ProjectDto, pullRequest: PullRequestDto): Promise<PullRequestDto> {
  try {
    const revision = `${pullRequest.targetBranch}..${pullRequest.sourceBranch}`;
    const [files, commitCount] = await Promise.all([
      getDiffFiles(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch),
      getCommitCount(project.repoPath, revision)
    ]);
    return {
      ...pullRequest,
      changedFileCount: files.length,
      commitCount
    };
  } catch {
    return pullRequest;
  }
}

function runtimeDefaults(project: ProjectDto, runtime?: ProjectSettingsDto["runtime"]): ProjectSettingsDto["runtime"] {
  return {
    server: {
      host: runtime?.server.host ?? "127.0.0.1",
      port: runtime?.server.port ?? 3580
    },
    database: {
      url: runtime?.database.url ?? repositoryDatabaseUrl(project.repoPath)
    }
  };
}

function aiDefaults(ai?: AiSettingsDto): AiSettingsDto {
  return normalizeAiSettings(ai);
}

async function readProjectSettings(
  repos: Repositories,
  project: ProjectDto,
  runtime?: ProjectSettingsDto["runtime"],
  ai?: ProjectSettingsDto["ai"]
): Promise<ProjectSettingsDto> {
  const [storedAi, automation] = await Promise.all([repos.settings.get("ai"), readAutomationSettings(repos)]);
  return {
    project: {
      locale: project.locale
    },
    ai: normalizeAiSettings(storedAi, aiDefaults(ai)),
    automation,
    runtime: runtimeDefaults(project, runtime)
  };
}

function patchAiSettings(current: AiSettingsDto, patch: z.infer<typeof updateProjectSettingsSchema>["ai"]): AiSettingsDto {
  if (!patch) {
    return current;
  }

  return normalizeAiSettings(
    {
      provider: patch.provider ?? current.provider,
      roleOverrides: Object.fromEntries(roleAiAgentTypes.map((agentType) => [
        agentType,
        {
          ...current.roleOverrides[agentType],
          ...(patch.roleOverrides?.[agentType] ?? {})
        }
      ])),
      codex: current.codex,
      claudeCode: {
        ...current.claudeCode,
        ...(patch.claudeCode ?? {})
      },
      lmStudio: {
        ...current.lmStudio,
        ...(patch.lmStudio ?? {})
      }
    },
    current
  );
}

async function saveAiSettings(repos: Repositories, settings: AiSettingsDto): Promise<void> {
  await repos.settings.set("ai", settings as unknown as Record<string, unknown>);
}

async function ensureRepository(input: { mode: "import" | "create"; repoPath: string; defaultBranch: string }): Promise<void> {
  if (input.mode === "import") {
    return;
  }

  await mkdir(input.repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-b", input.defaultBranch], { cwd: input.repoPath });
}

async function detectAndPersistCommands(
  repos: Repositories,
  projectId: string,
  repoPath: string,
  createIssuesForMissingCommands: boolean
) {
  const detection = await detectRepositoryCommands(repoPath);
  const commands = await repos.commands.upsertMany(
    projectId,
    detection.commands.map((command) => ({
      commandType: command.commandType,
      command: command.command,
      detectionSource: command.detectionSource,
      detectionDetails: command.detectionDetails,
      isRequired: command.isRequired,
      isAvailable: command.isAvailable
    }))
  );

  const createdIssueIds: number[] = [];
  if (createIssuesForMissingCommands) {
    const requirementsLabel = await repos.labels.findByName(projectId, workflowLabelNames.requirements);
    for (const command of detection.commands.filter((item) => !item.isAvailable)) {
      const issue = buildMissingCommandIssue({
        commandType: command.commandType,
        packageManager: command.detectionDetails.packageManager,
        signals: command.detectionDetails.signals,
        recommendation: command.detectionDetails.recommendation
      });
      const createdIssue = await repos.issues.create({
        projectId,
        title: issue.title,
        body: issue.body,
        createdByType: "system",
        labelIds: requirementsLabel ? [requirementsLabel.id] : []
      });
      await repos.agentJobs.create({
        projectId,
        agentType: "requirements",
        targetType: "issue",
        targetId: createdIssue.id,
        triggerType: "repository_imported",
        input: {
          reason: "missing_command",
          commandType: command.commandType
        }
      });
      createdIssueIds.push(createdIssue.id);
    }
  }

  return {
    packageManager: detection.packageManager,
    commands,
    missing: detection.missingCommands,
    createdIssueIds
  };
}

const humanGateFallbackLabels: Partial<Record<AgentType, string>> = {
  requirements: workflowLabelNames.requirements,
  implementation: workflowLabelNames.implementing,
  review: workflowLabelNames.reviewing,
  fix: workflowLabelNames.fixing,
  qa: workflowLabelNames.testing
};
const issueWorkflowLabelNameSet = new Set<string>(issueWorkflowLabelNames);

function readPreviousLabelIds(job: { output: Record<string, unknown> | null }): number[] | null {
  const metadata = job.output?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const humanGate = (metadata as Record<string, unknown>).humanGate;
  if (!humanGate || typeof humanGate !== "object" || Array.isArray(humanGate)) {
    return null;
  }
  const previousLabelIds = (humanGate as Record<string, unknown>).previousLabelIds;
  if (!Array.isArray(previousLabelIds)) {
    return null;
  }
  return previousLabelIds.filter((labelId): labelId is number => typeof labelId === "number");
}

async function restoreHumanGateLabels(repos: Repositories, job: AgentJobDto | null) {
  if (!job || job.targetType === "project") {
    return;
  }

  let labelIds = readPreviousLabelIds(job);
  if (!labelIds) {
    const fallbackLabelName = humanGateFallbackLabels[job.agentType];
    const fallbackLabel = fallbackLabelName ? await repos.labels.findByName(job.projectId, fallbackLabelName) : null;
    labelIds = fallbackLabel ? [fallbackLabel.id] : [];
  }

  if (job.targetType === "issue") {
    await repos.issues.update(job.projectId, job.targetId, { labelIds });
  } else {
    await repos.pullRequests.update(job.projectId, job.targetId, { labelIds });
  }

  await repos.activities.create({
    projectId: job.projectId,
    agentJobId: job.id,
    targetType: job.targetType,
    targetId: job.targetId,
    activityType: "system",
    title: "Human answer received",
    body: "Restored the previous workflow labels and requeued the waiting agent job."
  });
}

async function resumeWaitingJobForComment(
  repos: Repositories,
  input: {
    projectId: string;
    targetType: "issue" | "pull_request";
    targetId: number;
  }
) {
  const waitingJobs = await repos.agentJobs.list({
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId,
    status: "waiting_human"
  });
  const waitingJob = waitingJobs[0];
  if (!waitingJob) {
    return null;
  }

  await restoreHumanGateLabels(repos, waitingJob);
  return repos.agentJobs.resume(input.projectId, waitingJob.id);
}

export function createApp({
  ai,
  repos,
  runtime,
  staticRoot = "./dist/client",
  switchDatabaseForRepository
}: AppDependencies): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: {
            code: error.status === 404 ? "NOT_FOUND" : "HTTP_ERROR",
            message: error.message
          }
        },
        error.status
      );
    }

    console.error(error);
    return c.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected server error."
        }
      },
      500
    );
  });

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      name: "OneTeam"
    })
  );

  app.get("/api/projects", async (c) => {
    const items = await repos.projects.list();
    return c.json({ items });
  });

  app.get("/api/repositories", async (c) => {
    return c.json({ items: listSelectableRepositories() });
  });

  app.post("/api/repositories/switch", zValidator("json", switchRepositorySchema), async (c) => {
    const input = c.req.valid("json");
    const repository =
      (await switchDatabaseForRepository?.(input.repoPath, input.name)) ?? {
        repoPath: input.repoPath,
        name: input.name ?? input.repoPath,
        databaseUrl: repositoryDatabaseUrl(input.repoPath),
        lastOpenedAt: new Date().toISOString()
      };
    const projects = await repos.projects.list();
    return c.json({ repository, projects });
  });

  app.post("/api/projects", zValidator("json", createProjectSchema), async (c) => {
    const input = c.req.valid("json");
    await ensureRepository(input);
    await switchDatabaseForRepository?.(input.repoPath, input.name);
    await saveAiSettings(repos, normalizeAiSettings({ provider: input.aiProvider }, aiDefaults(ai)));
    const project = await repos.projects.create(input);
    await ensureKnowledgeFiles(project.repoPath);
    const detection = await detectAndPersistCommands(repos, project.id, project.repoPath, true);
    return c.json(
      {
        project,
        commandDetection: detection
      },
      201
    );
  });

  app.get("/api/projects/:projectId", async (c) => {
    const project = await repos.projects.get(c.req.param("projectId"));
    if (!project) {
      notFound("Project was not found.");
    }
    return c.json({ project });
  });

  app.patch("/api/projects/:projectId", zValidator("json", createProjectSchema.partial()), async (c) => {
    const project = await repos.projects.update(c.req.param("projectId"), c.req.valid("json"));
    if (!project) {
      notFound("Project was not found.");
    }
    return c.json({ project });
  });

  app.get("/api/projects/:projectId/settings", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    return c.json(await readProjectSettings(repos, project, runtime, ai));
  });

  app.put("/api/projects/:projectId/settings", zValidator("json", updateProjectSettingsSchema), async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const input = c.req.valid("json");
    const updatedProject = await repos.projects.update(project.id, { locale: input.locale });
    if (!updatedProject) {
      notFound("Project was not found.");
    }
    const currentSettings = await readProjectSettings(repos, updatedProject, runtime, ai);
    const nextAiSettings = patchAiSettings(currentSettings.ai, input.ai);
    const nextAutomationSettings: ProjectSettingsDto["automation"] = {
      ...currentSettings.automation,
      ...input.automation,
      autoMergeTargetBranches: input.automation?.autoMergeTargetBranches
        ? Array.from(new Set(input.automation.autoMergeTargetBranches.map((branch) => branch.trim()).filter(Boolean)))
        : currentSettings.automation.autoMergeTargetBranches
    };
    await Promise.all([
      saveAiSettings(repos, nextAiSettings),
      saveAutomationSettings(repos, nextAutomationSettings)
    ]);
    return c.json({
      ...currentSettings,
      ai: nextAiSettings,
      automation: nextAutomationSettings
    });
  });

  app.get("/api/projects/:projectId/labels", async (c) => {
    const items = await repos.labels.list(c.req.param("projectId"));
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/commands", async (c) => {
    const items = await repos.commands.list(c.req.param("projectId"));
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/commands/detect", zValidator("json", detectCommandsSchema), async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));

    const input = c.req.valid("json");
    const detection = await detectAndPersistCommands(
      repos,
      project.id,
      project.repoPath,
      input.createIssuesForMissingCommands
    );
    return c.json(detection);
  });

  app.get("/api/projects/:projectId/issues", async (c) => {
    const url = new URL(c.req.url);
    const { limit, offset } = pageParams(url);
    const status = url.searchParams.get("status") as IssueStatus | null;
    const q = url.searchParams.get("q") ?? undefined;
    const result = await repos.issues.list({
      projectId: c.req.param("projectId"),
      status: status ?? undefined,
      q,
      limit,
      offset
    });

    return c.json({
      items: await enrichWithLatestAgentStop(repos, c.req.param("projectId"), "issue", result.items),
      page: {
        limit,
        offset,
        total: result.total
      }
    });
  });

  app.post("/api/projects/:projectId/issues", zValidator("json", createIssueSchema), async (c) => {
    const projectId = c.req.param("projectId");
    const input = c.req.valid("json");
    const requirementsLabel = await repos.labels.findByName(projectId, workflowLabelNames.requirements);
    const labelIds = [...(input.labelIds ?? [])];
    const requestedWorkflowLabel = labelIds.length
      ? (await repos.labels.list(projectId)).some(
          (label) => labelIds.includes(label.id) && issueWorkflowLabelNameSet.has(label.name)
        )
      : false;
    if (requirementsLabel && !requestedWorkflowLabel && !labelIds.includes(requirementsLabel.id)) {
      labelIds.push(requirementsLabel.id);
    }
    const issue = await repos.issues.create({
      projectId,
      title: input.title,
      body: input.body,
      createdByType: "user",
      labelIds
    });
    const automationJobs = await runLabelAutomation(repos, {
      projectId,
      targetType: "issue",
      targetId: issue.id,
      labels: issue.labels,
      triggerType: "label_applied"
    });
    return c.json({ issue, automationJobIds: automationJobs.map((job) => job.id) }, 201);
  });

  app.get("/api/projects/:projectId/issues/:issueId", async (c) => {
    const issue = await repos.issues.get(c.req.param("projectId"), Number(c.req.param("issueId")));
    if (!issue) {
      notFound("Issue was not found.");
    }
    return c.json({ issue });
  });

  app.get("/api/projects/:projectId/issues/:issueId/objective", async (c) => {
    const projectId = c.req.param("projectId");
    const issueId = Number(c.req.param("issueId"));
    const issue = await repos.issues.get(projectId, issueId);
    if (!issue) {
      notFound("Issue was not found.");
    }
    const objective = await ensureObjectiveForTarget(repos, {
      projectId,
      targetType: "issue",
      targetId: issueId
    });
    return c.json({ objective });
  });

  app.patch("/api/projects/:projectId/issues/:issueId", zValidator("json", updateIssueSchema), async (c) => {
    const projectId = c.req.param("projectId");
    const issueId = Number(c.req.param("issueId"));
    const previousIssue = await repos.issues.get(projectId, issueId);
    const { goalChangeReason, ...input } = c.req.valid("json");
    const isReopening = previousIssue?.status === "closed" && input.status === "open";
    const isBodyChanging = typeof input.body === "string" && previousIssue?.body !== input.body;
    const previousObjective = isReopening || isBodyChanging
      ? await repos.objectives.findByIssue(projectId, issueId)
      : null;
    const changesActiveGoal =
      isBodyChanging &&
      !isReopening &&
      previousObjective !== null &&
      !["succeeded", "canceled"].includes(previousObjective.status);
    if (changesActiveGoal && !goalChangeReason) {
      badRequest("A Goal Contract change reason is required while an Objective is active.");
    }
    let patch = input;
    if (isReopening) {
      const labels = await repos.labels.list(projectId);
      const selectedLabelIds = new Set(input.labelIds ?? previousIssue.labels.map((label) => label.id));
      const preservedLabelIds = labels
        .filter((label) => selectedLabelIds.has(label.id) && !issueWorkflowLabelNameSet.has(label.name))
        .map((label) => label.id);
      const workflowLabel = await repos.labels.findByName(projectId, reopenedIssueWorkflowLabel(previousObjective));
      patch = { ...input, labelIds: workflowLabel ? [...preservedLabelIds, workflowLabel.id] : preservedLabelIds };
    }
    const issue = await repos.issues.update(projectId, issueId, patch);
    if (!issue) {
      notFound("Issue was not found.");
    }
    if (isReopening) {
      await recordIssueReopened(repos, { projectId, issue, previousObjective });
    } else if (changesActiveGoal && previousObjective && goalChangeReason) {
      await recordGoalContractChange(repos, {
        projectId,
        issue,
        objective: previousObjective,
        previousGoal: previousIssue?.body ?? "",
        reason: goalChangeReason
      });
    }
    const automationJobs = await runLabelAutomation(repos, {
      projectId,
      targetType: "issue",
      targetId: issue.id,
      labels: issue.labels,
      previousLabels: previousIssue?.labels ?? [],
      triggerType: "label_applied"
    });
    return c.json({ issue, automationJobIds: automationJobs.map((job) => job.id) });
  });

  app.delete("/api/projects/:projectId/issues/:issueId", async (c) => {
    const deleted = await repos.issues.softDelete(c.req.param("projectId"), Number(c.req.param("issueId")));
    if (!deleted) {
      notFound("Issue was not found.");
    }
    return c.json({ deleted });
  });

  app.get("/api/projects/:projectId/issues/:issueId/comments", async (c) => {
    const items = await repos.comments.list(c.req.param("projectId"), "issue", Number(c.req.param("issueId")));
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/issues/:issueId/comments", zValidator("json", createCommentSchema), async (c) => {
    const projectId = c.req.param("projectId");
    const issueId = Number(c.req.param("issueId"));
    const waitingJob = (
      await repos.agentJobs.list({
        projectId,
        targetType: "issue",
        targetId: issueId,
        status: "waiting_human"
      })
    )[0];
    const comment = await repos.comments.create({
      projectId,
      targetType: "issue",
      targetId: issueId,
      authorType: "user",
      body: c.req.valid("json").body,
      metadata: waitingJob ? { agentJobId: waitingJob.id, relation: "human_reply" } : undefined
    });
    const autoResumedJob = await resumeWaitingJobForComment(repos, {
      projectId,
      targetType: "issue",
      targetId: issueId
    });
    return c.json({ comment, autoResumedJobId: autoResumedJob?.id ?? null }, 201);
  });

  app.patch("/api/projects/:projectId/comments/:commentId", zValidator("json", updateCommentSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await repos.comments.updateUserComment({
      projectId: c.req.param("projectId"),
      commentId: Number(c.req.param("commentId")),
      body: input.body,
      expectedUpdatedAt: input.expectedUpdatedAt
    });
    if (result.state !== "updated") {
      if (result.state === "not_found") notFound("Comment was not found.");
      if (result.state === "forbidden") forbidden("Agent and system comments are immutable.");
      conflict("Comment changed after editing started. Reload it before saving again.");
    }
    return c.json({ comment: result.comment, revision: result.revision });
  });

  app.get("/api/projects/:projectId/comments/:commentId/revisions", async (c) => {
    const projectId = c.req.param("projectId");
    const commentId = Number(c.req.param("commentId"));
    const comment = await repos.comments.get(projectId, commentId);
    if (!comment) notFound("Comment was not found.");
    return c.json({ items: await repos.comments.listRevisions(projectId, commentId) });
  });

  app.get("/api/projects/:projectId/issues/:issueId/activities", async (c) => {
    const items = await repos.activities.list(c.req.param("projectId"), "issue", Number(c.req.param("issueId")));
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/pull-requests", async (c) => {
    const url = new URL(c.req.url);
    const { limit, offset } = pageParams(url);
    const status = url.searchParams.get("status") as PullRequestStatus | null;
    const issueIdParam = url.searchParams.get("issueId");
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const result = await repos.pullRequests.list({
      projectId: project.id,
      status: status ?? undefined,
      issueId: issueIdParam ? Number(issueIdParam) : undefined,
      limit,
      offset
    });
    const itemsWithStats = await Promise.all(result.items.map((item) => enrichPullRequestWithGitStats(project, item)));
    const items = await enrichWithLatestAgentStop(repos, project.id, "pull_request", itemsWithStats);

    return c.json({
      items,
      page: {
        limit,
        offset,
        total: result.total
      }
    });
  });

  app.post("/api/projects/:projectId/pull-requests", zValidator("json", createPullRequestSchema), async (c) => {
    const projectId = c.req.param("projectId");
    const reviewLabel = await repos.labels.findByName(projectId, workflowLabelNames.reviewing);
    const pullRequest = await repos.pullRequests.create({
      projectId,
      ...c.req.valid("json"),
      createdByType: "user",
      labelIds: c.req.valid("json").labelIds ?? (reviewLabel ? [reviewLabel.id] : [])
    });
    const automationJobs = await runLabelAutomation(repos, {
      projectId,
      targetType: "pull_request",
      targetId: pullRequest.id,
      labels: pullRequest.labels,
      triggerType: "label_applied"
    });
    return c.json({ pullRequest, automationJobIds: automationJobs.map((job) => job.id) }, 201);
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    return c.json({ pullRequest: await enrichPullRequestWithGitStats(project, pullRequest) });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/objective", async (c) => {
    const projectId = c.req.param("projectId");
    const pullRequestId = Number(c.req.param("pullRequestId"));
    const pullRequest = await repos.pullRequests.get(projectId, pullRequestId);
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const objective = await ensureObjectiveForTarget(repos, {
      projectId,
      targetType: "pull_request",
      targetId: pullRequestId
    });
    return c.json({ objective });
  });

  app.post("/api/projects/:projectId/objectives/:objectiveId/pause", async (c) => {
    const projectId = c.req.param("projectId");
    const objective = await repos.objectives.get(projectId, Number(c.req.param("objectiveId")));
    if (!objective) {
      notFound("Objective was not found.");
    }
    if (["paused", "ready_to_merge", "succeeded", "canceled"].includes(objective.status)) {
      conflict(`Objective cannot be paused while it is ${objective.status}.`);
    }
    return c.json(await pauseObjective(repos, objective));
  });

  app.post("/api/projects/:projectId/objectives/:objectiveId/resume", async (c) => {
    const projectId = c.req.param("projectId");
    const objective = await repos.objectives.get(projectId, Number(c.req.param("objectiveId")));
    if (!objective) {
      notFound("Objective was not found.");
    }
    if (objective.status !== "paused") {
      conflict("Only a paused Objective can be resumed.");
    }
    const result = await resumeObjective(repos, objective);
    if (!result.jobs.length) {
      if (result.objective.pullRequestId) {
        const pullRequest = await repos.pullRequests.get(projectId, result.objective.pullRequestId);
        if (pullRequest) {
          result.jobs.push(...await runLabelAutomation(repos, {
            projectId,
            targetType: "pull_request",
            targetId: pullRequest.id,
            labels: pullRequest.labels,
            triggerType: "objective_resumed"
          }));
        }
      } else if (result.objective.issueId) {
        const issue = await repos.issues.get(projectId, result.objective.issueId);
        if (issue) {
          result.jobs.push(...await runLabelAutomation(repos, {
            projectId,
            targetType: "issue",
            targetId: issue.id,
            labels: issue.labels,
            triggerType: "objective_resumed"
          }));
        }
      }
    }
    return c.json(result);
  });

  app.post("/api/projects/:projectId/objectives/:objectiveId/cancel", async (c) => {
    const projectId = c.req.param("projectId");
    const objective = await repos.objectives.get(projectId, Number(c.req.param("objectiveId")));
    if (!objective) {
      notFound("Objective was not found.");
    }
    if (["succeeded", "canceled"].includes(objective.status)) {
      conflict(`Objective cannot be canceled while it is ${objective.status}.`);
    }
    return c.json(await cancelObjective(repos, objective));
  });

  app.patch(
    "/api/projects/:projectId/pull-requests/:pullRequestId",
    zValidator("json", updatePullRequestSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const pullRequestId = Number(c.req.param("pullRequestId"));
      const previousPullRequest = await repos.pullRequests.get(projectId, pullRequestId);
      const pullRequest = await repos.pullRequests.update(projectId, pullRequestId, c.req.valid("json"));
      if (!pullRequest) {
        notFound("Pull request was not found.");
      }
      const automationJobs = await runLabelAutomation(repos, {
        projectId,
        targetType: "pull_request",
        targetId: pullRequest.id,
        labels: pullRequest.labels,
        previousLabels: previousPullRequest?.labels ?? [],
        triggerType: "label_applied"
      });
      return c.json({ pullRequest, automationJobIds: automationJobs.map((job) => job.id) });
    }
  );

  app.delete("/api/projects/:projectId/pull-requests/:pullRequestId", async (c) => {
    const deleted = await repos.pullRequests.softDelete(
      c.req.param("projectId"),
      Number(c.req.param("pullRequestId"))
    );
    if (!deleted) {
      notFound("Pull request was not found.");
    }
    return c.json({ deleted });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/comments", async (c) => {
    const items = await repos.comments.list(
      c.req.param("projectId"),
      "pull_request",
      Number(c.req.param("pullRequestId"))
    );
    return c.json({ items });
  });

  app.post(
    "/api/projects/:projectId/pull-requests/:pullRequestId/comments",
    zValidator("json", createCommentSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const pullRequestId = Number(c.req.param("pullRequestId"));
      const waitingJob = (
        await repos.agentJobs.list({
          projectId,
          targetType: "pull_request",
          targetId: pullRequestId,
          status: "waiting_human"
        })
      )[0];
      const comment = await repos.comments.create({
        projectId,
        targetType: "pull_request",
        targetId: pullRequestId,
        authorType: "user",
        body: c.req.valid("json").body,
        metadata: waitingJob ? { agentJobId: waitingJob.id, relation: "human_reply" } : undefined
      });
      const autoResumedJob = await resumeWaitingJobForComment(repos, {
        projectId,
        targetType: "pull_request",
        targetId: pullRequestId
      });
      return c.json({ comment, autoResumedJobId: autoResumedJob?.id ?? null }, 201);
    }
  );

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/line-comments", async (c) => {
    const projectId = c.req.param("projectId");
    const pullRequestId = Number(c.req.param("pullRequestId"));
    const pullRequest = await repos.pullRequests.get(projectId, pullRequestId);
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const comments = await repos.comments.list(projectId, "pull_request", pullRequestId);
    return c.json({ items: collectPullRequestLineComments(comments) });
  });

  app.post(
    "/api/projects/:projectId/pull-requests/:pullRequestId/line-comments",
    zValidator("json", createPullRequestLineCommentSchema),
    async (c) => {
      const project = await getProjectOr404(repos, c.req.param("projectId"));
      const pullRequestId = Number(c.req.param("pullRequestId"));
      const pullRequest = await repos.pullRequests.get(project.id, pullRequestId);
      if (!pullRequest) {
        notFound("Pull request was not found.");
      }
      const input = c.req.valid("json");
      const [sourceCommit, targetCommit] = await Promise.all([
        getRevisionHash(project.repoPath, pullRequest.sourceBranch),
        getRevisionHash(project.repoPath, pullRequest.targetBranch)
      ]);
      if (input.sourceCommit !== sourceCommit || input.targetCommit !== targetCommit) {
        conflict("Pull request branches changed. Refresh the diff before commenting.");
      }
      const files = await getDiffFiles(project.repoPath, sourceCommit, targetCommit);
      const file = files.find((candidate) => candidate.path === input.path);
      if (!file) {
        notFound("Changed file was not found.");
      }
      if (file.binary) {
        throw new HTTPException(400, { message: "Binary files do not support line comments." });
      }
      const patch = await getDiffFilePatch(project.repoPath, sourceCommit, targetCommit, file.path, {
        contextLines: 100_000,
        previousPath: file.previousPath
      });
      if (!diffPatchContainsLine(patch, input.side, input.line)) {
        throw new HTTPException(400, { message: "The selected line is not part of this pull request diff." });
      }
      const comment = await repos.comments.create({
        projectId: project.id,
        targetType: "pull_request",
        targetId: pullRequestId,
        authorType: "user",
        body: input.body,
        metadata: lineCommentMetadata({
          path: input.path,
          line: input.line,
          side: input.side,
          sourceCommit,
          targetCommit
        })
      });
      const lineComment = toPullRequestLineComment(comment);
      if (!lineComment) {
        throw new Error("Failed to create pull request line comment metadata.");
      }
      return c.json({ comment: lineComment }, 201);
    }
  );

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/activities", async (c) => {
    const items = await repos.activities.list(
      c.req.param("projectId"),
      "pull_request",
      Number(c.req.param("pullRequestId"))
    );
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/commits", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const items = await getCommits(project.repoPath, `${pullRequest.targetBranch}..${pullRequest.sourceBranch}`);
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/files", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const [sourceCommit, targetCommit] = await Promise.all([
      getRevisionHash(project.repoPath, pullRequest.sourceBranch),
      getRevisionHash(project.repoPath, pullRequest.targetBranch)
    ]);
    const files = await getDiffFiles(project.repoPath, sourceCommit, targetCommit);
    return c.json({ files, sourceCommit, targetCommit });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/findings", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequestId = Number(c.req.param("pullRequestId"));
    const pullRequest = await repos.pullRequests.get(project.id, pullRequestId);
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const jobs = await repos.agentJobs.list({
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequestId
    });
    return c.json({ items: collectPullRequestFindings(jobs) });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/diff", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const files = await getDiffWithPatches(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch);
    return c.json({ files });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/diff-file", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    const path = c.req.query("path");
    if (!path) {
      throw new HTTPException(400, { message: "A file path is required." });
    }
    const [sourceCommit, targetCommit] = await Promise.all([
      getRevisionHash(project.repoPath, pullRequest.sourceBranch),
      getRevisionHash(project.repoPath, pullRequest.targetBranch)
    ]);
    const expectedSourceCommit = c.req.query("sourceCommit");
    const expectedTargetCommit = c.req.query("targetCommit");
    if (
      (expectedSourceCommit && expectedSourceCommit !== sourceCommit) ||
      (expectedTargetCommit && expectedTargetCommit !== targetCommit)
    ) {
      throw new HTTPException(409, { message: "Pull request branches changed. Refresh the file list before loading this diff." });
    }
    const files = await getDiffFiles(project.repoPath, sourceCommit, targetCommit);
    const file = files.find((candidate) => candidate.path === path);
    if (!file) {
      notFound("Changed file was not found.");
    }
    const context = c.req.query("context");
    if (context && !["default", "wide", "full"].includes(context)) {
      throw new HTTPException(400, { message: "Diff context must be default, wide, or full." });
    }
    const patch = await getDiffFilePatch(project.repoPath, sourceCommit, targetCommit, path, {
      contextLines: context === "wide" ? 20 : context === "full" ? 100_000 : undefined,
      ignoreWhitespace: c.req.query("whitespace") === "ignore",
      previousPath: file.previousPath
    });
    return c.json({ file: { ...file, patch }, sourceCommit, targetCommit });
  });

  app.get("/api/projects/:projectId/pull-requests/:pullRequestId/conflicts", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequest = await repos.pullRequests.get(project.id, Number(c.req.param("pullRequestId")));
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    return c.json(await detectMergeConflicts(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch));
  });

  app.post("/api/projects/:projectId/pull-requests/:pullRequestId/merge", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const pullRequestId = Number(c.req.param("pullRequestId"));
    const pullRequest = await repos.pullRequests.get(project.id, pullRequestId);
    if (!pullRequest) {
      notFound("Pull request was not found.");
    }
    let mergeResult: Awaited<ReturnType<typeof mergePullRequest>>;
    try {
      mergeResult = await mergePullRequest(repos, { project, pullRequest, mode: "manual" });
    } catch (error) {
      conflict(errorMessage(error, "Merge failed."));
    }
    if (mergeResult.state !== "merged") {
      conflict(mergeResult.reason);
    }

    return c.json({
      pullRequest: await enrichPullRequestWithGitStats(project, mergeResult.pullRequest),
      mergeCommit: mergeResult.mergeCommit,
      output: mergeResult.output
    });
  });

  app.post("/api/projects/:projectId/pull-requests/:pullRequestId/resolve-conflicts", async (c) => {
    const projectId = c.req.param("projectId");
    const pullRequestId = Number(c.req.param("pullRequestId"));
    const previousPullRequest = await repos.pullRequests.get(projectId, pullRequestId);
    if (!previousPullRequest) {
      notFound("Pull request was not found.");
    }
    const conflictLabel = await repos.labels.findByName(projectId, workflowLabelNames.resolvingConflicts);
    let pullRequest = previousPullRequest;
    if (conflictLabel) {
      pullRequest =
        (await repos.pullRequests.update(projectId, pullRequestId, { labelIds: [conflictLabel.id] })) ??
        previousPullRequest;
    }
    const automationJobs = await runLabelAutomation(repos, {
      projectId,
      targetType: "pull_request",
      targetId: pullRequestId,
      labels: pullRequest.labels,
      triggerType: "conflict_detected"
    });
    return c.json({ jobId: automationJobs[0]?.id ?? null, label: workflowLabelNames.resolvingConflicts });
  });

  app.get("/api/projects/:projectId/loops", async (c) => {
    const items = await repos.loops.list(c.req.param("projectId"));
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/loops", zValidator("json", createLoopSchema), async (c) => {
    const loop = await repos.loops.create({
      projectId: c.req.param("projectId"),
      ...c.req.valid("json")
    });
    return c.json({ loop }, 201);
  });

  app.get("/api/projects/:projectId/loops/:loopId", async (c) => {
    const projectId = c.req.param("projectId");
    const loopId = Number(c.req.param("loopId"));
    const loop = await repos.loops.get(projectId, loopId);
    if (!loop) {
      notFound("Loop was not found.");
    }
    const runs = await repos.loopRuns.list(projectId, loopId);
    return c.json({ loop, runs });
  });

  app.patch("/api/projects/:projectId/loops/:loopId", zValidator("json", updateLoopSchema), async (c) => {
    const loop = await repos.loops.update(c.req.param("projectId"), Number(c.req.param("loopId")), c.req.valid("json"));
    if (!loop) {
      notFound("Loop was not found.");
    }
    return c.json({ loop });
  });

  app.post("/api/projects/:projectId/loops/:loopId/runs", zValidator("json", startLoopRunSchema), async (c) => {
    const projectId = c.req.param("projectId");
    const loopId = Number(c.req.param("loopId"));
    const loop = await repos.loops.get(projectId, loopId);
    if (!loop) {
      notFound("Loop was not found.");
    }
    if (loop.status === "disabled") {
      conflict("Disabled loops cannot be started.");
    }

    const input = c.req.valid("json");
    const { run, job, step } = await startLoopRun(repos, {
      projectId,
      loopId,
      agentType: input.agentType,
      targetType: input.targetType,
      targetId: input.targetId,
      triggerType: input.triggerType,
      objectiveRunId:
        (typeof input.input?.objectiveRunId === "number" ? input.input.objectiveRunId : null) ??
        (await ensureObjectiveForTarget(repos, {
          projectId,
          targetType: input.targetType,
          targetId: input.targetId
        }))?.id ??
        null,
      jobInput: input.input
    });
    return c.json({ run, job, step }, 201);
  });

  app.get("/api/projects/:projectId/loop-runs", async (c) => {
    const url = new URL(c.req.url);
    const loopIdParam = url.searchParams.get("loopId");
    const items = await repos.loopRuns.list(c.req.param("projectId"), loopIdParam ? Number(loopIdParam) : undefined);
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/loop-runs/:loopRunId", async (c) => {
    const projectId = c.req.param("projectId");
    const loopRunId = Number(c.req.param("loopRunId"));
    const run = await repos.loopRuns.get(projectId, loopRunId);
    if (!run) {
      notFound("Loop run was not found.");
    }
    const steps = await repos.loopSteps.list(projectId, loopRunId);
    return c.json({ run, steps });
  });

  app.get("/api/projects/:projectId/loop-memory", async (c) => {
    const items = await repos.loopMemory.list(c.req.param("projectId"));
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/loop-memory", zValidator("json", createLoopMemorySchema), async (c) => {
    const entry = await repos.loopMemory.create({
      projectId: c.req.param("projectId"),
      ...c.req.valid("json")
    });
    return c.json({ entry }, 201);
  });

  app.get("/api/projects/:projectId/triage-items", async (c) => {
    const url = new URL(c.req.url);
    const status = url.searchParams.get("status") as "open" | "converted" | "ignored" | null;
    const items = await repos.triage.list(c.req.param("projectId"), status ?? undefined);
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/triage-items", zValidator("json", createTriageItemSchema), async (c) => {
    const item = await repos.triage.create({
      projectId: c.req.param("projectId"),
      ...c.req.valid("json")
    });
    return c.json({ item }, 201);
  });

  app.patch("/api/projects/:projectId/triage-items/:triageItemId", zValidator("json", updateTriageItemSchema), async (c) => {
    const item = await repos.triage.update(
      c.req.param("projectId"),
      Number(c.req.param("triageItemId")),
      c.req.valid("json")
    );
    if (!item) {
      notFound("Triage item was not found.");
    }
    return c.json({ item });
  });

  app.post("/api/projects/:projectId/triage-items/:triageItemId/convert-to-issue", async (c) => {
    const projectId = c.req.param("projectId");
    const triageItemId = Number(c.req.param("triageItemId"));
    const items = await repos.triage.list(projectId);
    const triageItem = items.find((item) => item.id === triageItemId);
    if (!triageItem) {
      notFound("Triage item was not found.");
    }
    const requirementsLabel = await repos.labels.findByName(projectId, workflowLabelNames.requirements);
    const issue = await repos.issues.create({
      projectId,
      title: triageItem.title,
      body: triageItem.body,
      createdByType: "user",
      labelIds: requirementsLabel ? [requirementsLabel.id] : []
    });
    await runLabelAutomation(repos, {
      projectId,
      targetType: "issue",
      targetId: issue.id,
      labels: issue.labels,
      triggerType: "triage_converted"
    });
    const updatedItem = await repos.triage.update(projectId, triageItemId, { status: "converted", issueId: issue.id });
    await repos.loopMemory.create({
      projectId,
      sourceType: "triage",
      sourceId: triageItem.id,
      title: `Triage converted to issue #${issue.id}`,
      body: triageItem.title,
      tags: ["triage", "issue"]
    });
    return c.json({ issue, triageItem: updatedItem });
  });

  app.get("/api/projects/:projectId/knowledge", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const items = await listKnowledgeFiles(project.repoPath);
    return c.json({ items });
  });

  app.put("/api/projects/:projectId/knowledge/*", zValidator("json", updateKnowledgeFileSchema), async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const path = c.req.path.split("/knowledge/")[1] ?? "";
    const item = await writeKnowledgeFile(project.repoPath, path, c.req.valid("json").body);
    return c.json({ item });
  });

  app.get("/api/projects/:projectId/agent-jobs", async (c) => {
    const url = new URL(c.req.url);
    const targetType = url.searchParams.get("targetType") as "issue" | "pull_request" | "project" | null;
    const targetIdParam = url.searchParams.get("targetId");
    const status = url.searchParams.get("status") as AgentJobStatus | null;
    const items = await repos.agentJobs.list({
      projectId: c.req.param("projectId"),
      targetType: targetType ?? undefined,
      targetId: targetIdParam ? Number(targetIdParam) : undefined,
      status: status ?? undefined
    });
    return c.json({ items });
  });

  app.post("/api/projects/:projectId/agent-jobs", zValidator("json", createAgentJobSchema), async (c) => {
    const input = c.req.valid("json");
    const projectId = c.req.param("projectId");
    const agentType = input.agentType as AgentType;
    const objective = await ensureObjectiveForTarget(repos, {
      projectId,
      targetType: input.targetType,
      targetId: input.targetId
    });
    if (objective && ["paused", "canceled", "succeeded"].includes(objective.status)) {
      conflict(`Agent work cannot be queued while Objective #${objective.id} is ${objective.status}.`);
    }
    const job = await repos.agentJobs.create({
      projectId,
      agentType,
      targetType: input.targetType,
      targetId: input.targetId,
      triggerType: input.triggerType,
      input: {
        ...(input.input ?? {}),
        objectiveRunId: objective?.id ?? null
      },
      lockKey: resolveAgentJobLockKey({
        projectId,
        agentType,
        targetType: input.targetType,
        targetId: input.targetId
      })
    });
    return c.json({ job }, 201);
  });

  app.get("/api/projects/:projectId/agent-jobs/:jobId/artifacts/:fileName", async (c) => {
    const projectId = c.req.param("projectId");
    const jobId = Number(c.req.param("jobId"));
    const [project, job] = await Promise.all([
      repos.projects.get(projectId),
      repos.agentJobs.get(projectId, jobId)
    ]);
    if (!project || !job || !agentJobReferencesArtifact(job, c.req.param("fileName"))) {
      notFound("Agent artifact was not found.");
    }
    const artifact = await readStoredEvidenceArtifact(project, jobId, c.req.param("fileName"));
    if (!artifact) notFound("Agent artifact was not found.");
    const content = await readFile(artifact.absolutePath);
    return c.body(content, 200, {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(artifact.byteSize),
      "Content-Type": artifact.mediaType,
      "X-Content-Type-Options": "nosniff"
    });
  });

  app.get("/api/projects/:projectId/agent-jobs/:jobId", async (c) => {
    const job = await repos.agentJobs.get(c.req.param("projectId"), Number(c.req.param("jobId")));
    if (!job) {
      notFound("Agent job was not found.");
    }
    return c.json({ job });
  });

  app.post("/api/projects/:projectId/agent-jobs/:jobId/cancel", async (c) => {
    const projectId = c.req.param("projectId");
    const job = await repos.agentJobs.get(projectId, Number(c.req.param("jobId")));
    if (!job) {
      notFound("Agent job was not found.");
    }
    if (["succeeded", "failed", "canceled"].includes(job.status)) {
      return c.json({ canceled: false, job });
    }

    const canceledJob = await repos.agentJobs.updateStatus(projectId, job.id, "canceled", {
      error: job.status === "running" ? "Cancellation requested." : null
    });
    if (!canceledJob) {
      notFound("Agent job was not found.");
    }
    if (job.status === "waiting_provider") {
      await recordProviderWaitCanceled(repos, job);
    }

    if (job.targetType !== "project") {
      await repos.activities.create({
        projectId,
        agentJobId: job.id,
        targetType: job.targetType,
        targetId: job.targetId,
        activityType: "system",
        title: "Agent job cancellation requested",
        body:
          job.status === "running"
            ? "The running agent job will stop at the next cancellation check."
            : "The queued agent job was canceled before it started."
      });
    }

    return c.json({ canceled: true, job: canceledJob });
  });

  app.post("/api/projects/:projectId/agent-jobs/:jobId/retry", async (c) => {
    const job = await repos.agentJobs.retry(c.req.param("projectId"), Number(c.req.param("jobId")));
    if (!job) {
      notFound("Agent job was not found.");
    }
    return c.json({ jobId: job.id });
  });

  app.post(
    "/api/projects/:projectId/agent-jobs/:jobId/resume",
    zValidator("json", resumeProviderWaitSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const job = await repos.agentJobs.get(projectId, Number(c.req.param("jobId")));
      if (!job) {
        notFound("Agent job was not found.");
      }
      if (job.status !== "waiting_provider") {
        conflict("Only jobs waiting for an AI provider can be resumed here.");
      }
      const input = c.req.valid("json");
      const resumed = await resumeProviderWait(repos, job, "manual", input.aiProvider ?? job.aiProvider);
      if (!resumed) {
        conflict("The provider wait changed before it could be resumed.");
      }
      return c.json({ job: resumed });
    }
  );

  app.get("/api/projects/:projectId/agent-jobs/:jobId/activities", async (c) => {
    const job = await repos.agentJobs.get(c.req.param("projectId"), Number(c.req.param("jobId")));
    if (!job || job.targetType === "project") {
      return c.json({ items: [] });
    }
    const items = await repos.activities.list(c.req.param("projectId"), job.targetType, job.targetId);
    return c.json({ items });
  });

  app.get("/api/projects/:projectId/repository/status", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    return c.json(await getRepositoryStatus(project.repoPath));
  });

  app.get("/api/projects/:projectId/repository/branches", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    return c.json({ items: await getBranches(project.repoPath) });
  });

  app.get("/api/projects/:projectId/repository/commits", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    return c.json({ items: await getCommits(project.repoPath, "--all", 50) });
  });

  app.get("/api/projects/:projectId/repository/files", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const status = await getRepositoryStatus(project.repoPath);
    return c.json({ items: status.changedFiles });
  });

  app.get("/api/projects/:projectId/repository/merge-conflicts", async (c) => {
    const project = await getProjectOr404(repos, c.req.param("projectId"));
    const url = new URL(c.req.url);
    const sourceBranch = url.searchParams.get("sourceBranch") ?? project.defaultBranch;
    const targetBranch = url.searchParams.get("targetBranch") ?? project.defaultBranch;
    return c.json(await detectMergeConflicts(project.repoPath, sourceBranch, targetBranch));
  });

  app.use("/*", serveStatic({ root: staticRoot }));
  app.get("*", serveStatic({ path: `${staticRoot}/index.html` }));

  return app;
}
