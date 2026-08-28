import type { AgentJobDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { objectiveForJob } from "./objective-runs";

export async function recoverInterruptedAgentJobs(
  repos: Repositories,
  projectId?: string
): Promise<AgentJobDto[]> {
  const recoveredJobs = await repos.agentJobs.requeueInterrupted(projectId);
  for (const job of recoveredJobs) {
    const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
    if (step) {
      await Promise.all([
        repos.loopSteps.updateForAgentJob(job.projectId, job.id, { status: "queued" }),
        repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "queued", {
          summary: `Recovered interrupted agent job #${job.id}; execution is queued to resume.`,
          stopReason: "runtime_restarted"
        })
      ]);
    }

    const objective = await objectiveForJob(repos, job);
    if (objective && objective.status === "running") {
      await repos.objectives.update(job.projectId, objective.id, {
        summary: `Recovered interrupted ${job.agentType} job #${job.id}; the same objective will resume without spending a round.`
      });
    }

    if (job.targetType !== "project") {
      await repos.activities.create({
        projectId: job.projectId,
        agentJobId: job.id,
        targetType: job.targetType,
        targetId: job.targetId,
        activityType: "system",
        title: "Interrupted agent job recovered",
        body: `Job #${job.id} was running when OneTeam stopped. It was safely requeued as attempt ${job.attempt}.`,
        payload: {
          attempt: job.attempt,
          recoveryReason: "runtime_restarted"
        }
      });
    }
  }
  return recoveredJobs;
}
