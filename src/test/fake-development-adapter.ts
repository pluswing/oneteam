import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentRunResult } from "../server/agents/types";
import type { Repositories } from "../server/db/repositories";
import { knowledgeHash, readKnowledgeBody } from "../server/services/knowledge-files";
const exec = promisify(execFile);
/** Deterministic LLM substitute; Git, checks, merge, knowledge and UI use production code. */
export function fakeDevelopmentAdapter(repos: Repositories): AgentAdapter {
  return { async run({ job, repoPath, prompt, onActivity }): Promise<AgentRunResult> {
    const model = job.agentType === "requirements" ? "fixture-light" : "fixture-standard";
    const execution = await repos.development.executions.create({ projectId: job.projectId, jobId: job.id, selectedModel: model, effort: "medium", selectionReason: "Deterministic browser test model selection.", policyVersion: "fixture-v1" });
    await repos.development.setJobModel(job.projectId, job.id, model);
    await repos.development.executions.update(job.projectId, execution.id, { resolvedModel: model, threadId: `fixture-${job.id}`, turnId: `fixture-turn-${job.id}`, status: "succeeded", finishedAt: new Date().toISOString() });
    await onActivity?.({ type: "system", title: "Model selected", body: `${model}: Deterministic browser test model selection.` });
    if (prompt.includes("Check fixtures before editing a feature.")) await onActivity?.({ type: "system", title: "Learning received", body: "Check fixtures before editing a feature." });
    const success = { status: "succeeded" as const, message: `${job.agentType} completed`, stopReason: "passed" as const };
    if (job.agentType === "requirements") return { ...success, metadata: { goalContract: { evidenceRequired: [{ type: "file_change", required: true, commitScope: "source", maxAgeHours: 24 }] } } };
    if (job.agentType === "implementation") {
      await writeFile(join(repoPath, `feature-${job.targetId}.txt`), "Implemented\n");
      const branch = (await exec("git", ["branch", "--show-current"], { cwd: repoPath })).stdout.trim();
      return { ...success, metadata: { pullRequest: { title: `Feature for Issue #${job.targetId}`, sourceBranch: branch, targetBranch: "main", issueId: job.targetId } } };
    }
    if (job.agentType === "review") return { ...success, metadata: { review: { verdict: "approved", findings: [], checked: ["diff"] } } };
    if (job.agentType === "qa") return { ...success, metadata: { qa: { verdict: "passed", defects: [], observations: [] } } };
    if (job.agentType === "verifier") return { ...success, metadata: { verifier: { verdict: "passed", stopConditionMet: true, missingEvidence: [], notes: [] } } };
    if (job.agentType === "retrospective") {
      const project = (await repos.projects.get(job.projectId))!;
      const before = await readKnowledgeBody(project.repoPath, "AGENTS.md");
      return { ...success, metadata: { retrospective: { body: `Loop #${job.input.developmentLoopId} completed. Review and verification confirmed the fixture change.`, changes: before?.includes("Check fixtures before editing") ? [] : [{ path: "AGENTS.md", beforeHash: knowledgeHash(before), body: "# Project knowledge\n\nCheck fixtures before editing a feature.\n", reason: `Review of Loop #${job.input.developmentLoopId} established a reusable testing practice.` }] } } };
    }
    throw new Error(`Unexpected role ${job.agentType}`);
  } };
}
