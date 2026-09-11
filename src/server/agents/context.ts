import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentJobDto, CommentDto, IssueDto, ProjectDto, PullRequestDto, SkillFileDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { knowledgeHash, readKnowledgeFiles } from "../services/knowledge-files";
import { objectiveForJob } from "../services/objective-runs";
import { buildAgentPrompt } from "./prompts";

const exec = promisify(execFile);

export async function buildPromptForJob(repos: Repositories, job: AgentJobDto): Promise<{ project: ProjectDto; prompt: string }> {
  const project = await repos.projects.get(job.projectId);
  if (!project) throw new Error(`Project was not found: ${job.projectId}`);
  const [commands, files, objective] = await Promise.all([repos.commands.list(project.id), readKnowledgeFiles(project.repoPath), objectiveForJob(repos, job)]);
  let target: IssueDto | PullRequestDto | ProjectDto = project;
  let comments: CommentDto[] = [];
  if (job.targetType === "issue") {
    const issue = await repos.issues.get(project.id, job.targetId);
    if (!issue) throw new Error(`Issue was not found: ${job.targetId}`);
    target = issue;
    comments = await repos.comments.list(project.id, "issue", issue.id);
  } else if (job.targetType === "pull_request") {
    const pr = await repos.pullRequests.get(project.id, job.targetId);
    if (!pr) throw new Error(`Pull request was not found: ${job.targetId}`);
    target = pr;
    comments = await repos.comments.list(project.id, "pull_request", pr.id);
  }
  const knowledge = selectKnowledge(job.agentType === "retrospective" ? files.filter((file) => !file.path.startsWith("skills/")) : files, job.agentType, JSON.stringify(target), job.agentType === "retrospective" ? 64_000 : 16_000);
  const revisions = await repos.development.revisions.list(project.id);
  job.input = { ...job.input, knowledgeContext: {
    revision: revisions.find((revision) => revision.status === "applied")?.id ?? null,
    files: knowledge.map((file) => ({ path: file.path, hash: knowledgeHash(file.body) }))
  } };
  await repos.development.updateJobInput(project.id, job.id, job.input);
  if (job.agentType === "retrospective") {
    const loopId = job.input.developmentLoopId;
    const loop = typeof loopId === "number" ? await repos.development.get(project.id, loopId) : null;
    if (!loop?.mergeCommit) throw new Error("Retrospective requires a completed merge.");
    job.input.mergeCommit = loop.mergeCommit;
    await repos.development.updateJobInput(project.id, job.id, job.input);
    const issue = await repos.issues.get(project.id, loop.issueId);
    const jobs = (await repos.agentJobs.list({ projectId: project.id })).filter((item) => item.input.developmentLoopId === loop.id && item.id !== job.id);
    const history = await Promise.all(jobs.map(async (item) => ({
      id: item.id, role: item.agentType, status: item.status, output: boundedOutput(item.output), error: item.error, startedAt: item.startedAt, finishedAt: item.finishedAt,
      executions: await repos.development.executions.list(project.id, item.id)
    })));
    const diff = (await exec("git", ["diff", "--no-ext-diff", `${loop.mergeCommit}^1`, loop.mergeCommit, "--"], { cwd: project.repoPath, maxBuffer: 4 * 1024 * 1024 })).stdout;
    return { project, prompt: [
      "You are OneTeam's retrospective agent. The PR has already been merged. Reflect on the entire development loop, including retries, review findings, command failures, model choices, and elapsed time.",
      `Write user-visible text in ${project.locale === "ja" ? "Japanese" : "English"}.`,
      "Do not edit files or run modifying commands. Return a structured proposal. Learn specific, evidence-backed practices that will improve the next task; cite the Issue, PR, Job IDs or test results supporting each lesson.",
      "Propose create, update, consolidate or delete operations only for AGENTS.md or knowledge/<name>.md inside .oneteam. Use beforeHash from the supplied knowledge for edits, or null for a new file; body null means delete. Preserve user-authored instructions and never weaken acceptance criteria. AGENTS.md must remain a short index and shared guidance. Keep detailed practices in knowledge/. Do not include secrets or raw logs. If nothing reusable was learned, return an empty changes array and explain why. Include deferred code improvements as suggestions in the report, not file edits.",
      "Return JSON: { status: 'succeeded', message: 'summary', metadata: { retrospective: { body: 'Markdown report', changes: [{path, beforeHash, body, reason}] } } }.",
      JSON.stringify({ loop, issue, pullRequest: target, commands, history, diff: diff.slice(0, 80_000), diffTruncated: diff.length > 80_000, knowledge: knowledge.map((file) => ({ ...file, beforeHash: knowledgeHash(file.body) })) }, null, 2)
    ].join("\n\n") };
  }
  return { project, prompt: buildAgentPrompt(job, { project, target, objective, comments: comments.slice(-30), commands, knowledge }) };
}

function boundedOutput(output: Record<string, unknown> | null): unknown {
  if (!output) return null;
  // Avoid feeding screenshots, command dumps and repeated raw logs into reflection.
  const reduced = { message: output.message, metadata: output.metadata, changedFiles: output.changedFiles, stopReason: output.stopReason, testResults: output.testResults, evidence: output.evidence };
  const serialized = JSON.stringify(reduced);
  return serialized.length <= 12_000 ? reduced : { message: output.message, excerpt: serialized.slice(0, 12_000), truncated: true };
}

export function selectKnowledge(files: SkillFileDto[], role: string, task: string, budget = 16_000): SkillFileDto[] {
  const relevance = role === "qa" || role === "verifier" ? /test|build|qa|pitfall/i : role === "review" ? /review|architecture|pitfall/i : /architecture|development|project|build/i;
  const sorted = [...files].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
  const selected: SkillFileDto[] = [];
  let remaining = budget;
  for (const file of sorted) {
    if (file.body.length <= remaining) { selected.push(file); remaining -= file.body.length; }
    else if (file.path === "AGENTS.md") throw new Error(".oneteam/AGENTS.md is too large. Move detailed guidance into knowledge/ files.");
  }
  return selected;
  function score(file: SkillFileDto): number {
    if (file.path === "AGENTS.md") return 100;
    const tokens = file.title.toLowerCase().split(/[\W_]+/).filter((word) => word.length > 2);
    return (relevance.test(file.path) ? 10 : 0) + tokens.filter((word) => task.toLowerCase().includes(word)).length * 3;
  }
}
