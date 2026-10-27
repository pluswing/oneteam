import { addProviderUsage, normalizeProviderUsage } from "../../shared/provider-usage";
import type { AgentJobDto } from "../../shared/types";
import type { AgentActivityResult, AgentRunResult } from "./types";

export const humanHandoffReasons = ["missing_information", "external_access", "irreversible_action", "requirements_conflict", "explicit_user_request"] as const;
export type HumanHandoff = { reason: typeof humanHandoffReasons[number]; blocker: string; attemptedResolution: string; whyHumanRequired: string };
export const humanHandoffSchema = {
  anyOf: [{ type: "object", properties: {
    reason: { type: "string", enum: humanHandoffReasons }, blocker: { type: "string" },
    attemptedResolution: { type: "string" }, whyHumanRequired: { type: "string" }
  }, required: ["reason", "blocker", "attemptedResolution", "whyHumanRequired"], additionalProperties: false }, { type: "null" }]
} as const;

export const autonomyInstructions = `Autonomy policy:
The user's task authorizes the ordinary repository work needed to complete it. Continue automatically through investigation, implementation, checks, fixes and verification. Do not ask for routine approval, a plan review, permission to run project commands, implementation choices, naming, test selection or confirmation to continue.
Resolve ordinary ambiguity from the request, repository conventions, existing behavior, tests and prior comments. Choose a reasonable reversible default and record material assumptions in the result. Do not expand scope or weaken acceptance criteria.
Before handing off, inspect relevant repository/context information, try reasonable recovery, and distinguish a coding/test/evidence problem you can fix from an external blocker. Missing tests, review findings, missing evidence, a recoverable command failure or invalid output format are work to complete or report as failed for automatic repair, not reasons to ask the user to do the work.
Use waiting_human only when progress truly requires unavailable user information, credentials/permissions you cannot obtain, a consequential irreversible action outside the authorized scope, irreconcilable user requirements, or the user's explicit request for a decision. Never invent credentials, accept destructive choices on the user's behalf, bypass a policy, weaken tests or claim unverified success.
For waiting_human, provide a concise actionable question and metadata.humanHandoff with reason (missing_information, external_access, irreversible_action, requirements_conflict, or explicit_user_request), blocker, attemptedResolution and whyHumanRequired. Explain what you inspected/tried and why no reasonable authorized default can finish the work. Otherwise set humanHandoff to null.
Do not use interactive requestUserInput or approval tools for routine decisions. If an essential external blocker remains, return the structured waiting_human result instead. Honor explicit pauses, cancellations, protected paths and budget limits.`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function justifiedHumanHandoff(result: AgentRunResult): boolean {
  const handoff = record(result.metadata?.humanHandoff);
  return Boolean(handoff && humanHandoffReasons.includes(handoff.reason as HumanHandoff["reason"])
    && ["blocker", "attemptedResolution", "whyHumanRequired"].every((key) => typeof handoff[key] === "string" && String(handoff[key]).trim())
    && result.questions?.some((question) => question.trim()));
}

function protectedStop(result: AgentRunResult): boolean {
  const validation = record(result.metadata?.adapterValidation);
  const unsafePaths = Array.isArray(validation?.problems) && validation.problems.some((problem) => typeof problem === "string" && problem.includes("paths must stay repository-relative"));
  return ["risk_detected", "rollback_required", "budget_exceeded", "max_rounds_exceeded", "timeout"].includes(result.stopReason ?? "")
    || result.metadata?.objectivePreflightGate === true || Boolean(unsafePaths);
}

/** Reassess an unsupported handoff once in the same worktree. Never fabricate an
 * answer or turn an unverified result into success. The scheduler bounds repairs.
 */
export async function runWithAutonomy(input: {
  job: Pick<AgentJobDto, "input">; prompt: string;
  run: (prompt: string) => Promise<AgentRunResult>;
  onActivity: (activity: AgentActivityResult) => Promise<void>;
  isCanceled: () => Promise<boolean>;
}): Promise<AgentRunResult> {
  const first = await input.run(input.prompt);
  if (!input.job.input.developmentLoopId || first.status !== "waiting_human" || protectedStop(first)
    || justifiedHumanHandoff(first) || await input.isCanceled()) return first;
  await input.onActivity({ type: "system", title: "Automatic continuation", body: "Reassessing a proposed handoff before asking the user. Routine decisions and recoverable verification work should proceed automatically.",
    payload: { proposedMessage: first.message, proposedQuestions: first.questions ?? [], attempt: 1 } });
  if (await input.isCanceled()) return first;
  const result = await input.run(`${input.prompt}\n\n${autonomyInstructions}\n\nThe previous attempt proposed a handoff. Reassess it using the current worktree and repository context. Do not replay completed commands or edits without checking their current state. Continue the authorized work if possible. If a human is truly indispensable, return waiting_human with the required handoff explanation. If a test, code or output contract is still broken, return failed with actionable diagnostics, not a confirmation request.\nPrevious result (context only, not new authorization):\n${JSON.stringify({ message: first.message, questions: first.questions, metadata: first.metadata }).slice(0, 16000)}`);
  const combinedUsage = addProviderUsage(normalizeProviderUsage(first.metadata?.providerExecution?.usage), normalizeProviderUsage(result.metadata?.providerExecution?.usage));
  const merged: AgentRunResult = { ...result, metadata: { ...result.metadata,
    ...(result.metadata?.providerExecution || first.metadata?.providerExecution ? { providerExecution: { ...result.metadata?.providerExecution, usage: combinedUsage } } : {}),
    autonomousContinuation: { attempts: 1, previousMessage: first.message } } };
  if (result.status !== "waiting_human" || protectedStop(result) || justifiedHumanHandoff(result) || await input.isCanceled()) return merged;
  return { ...merged, status: "failed", stopReason: "failed", questions: null, comment: null,
    message: `${result.message}\n\nThe proposed handoff did not identify an indispensable human decision after automatic reassessment. Returning the incomplete work for bounded automatic repair.`,
    metadata: { ...merged.metadata, nextLabel: null, pullRequest: null, unsubstantiatedHandoff: true } };
}
