import type { AgentRunResult, AgentStopReason } from "./types";

const statuses = new Set(["succeeded", "waiting_human", "failed", "canceled"]);

export function validateAdapterStopResult(result: AgentRunResult, providerName: string): AgentRunResult {
  const problems = structuralProblems(result);
  if (problems.length) {
    return blockedStopResult(result, providerName, problems);
  }

  const status = result.status;
  const stopReason = normalizedStopReason(status, result.stopReason);
  return {
    ...result,
    stopReason,
    metadata: {
      ...(result.metadata ?? {}),
      adapterValidation: {
        hook: "stop",
        provider: providerName,
        passed: true,
        problems: []
      }
    }
  };
}

export function unstructuredAdapterStopResult(text: string, providerName: string): AgentRunResult {
  const message = text.trim() || `${providerName} completed without a structured response.`;
  return blockedStopResult(
    {
      status: "waiting_human",
      message,
      activities: [{ type: "progress", title: `${providerName} response captured`, body: text.trim() }]
    },
    providerName,
    ["The provider did not return a structured AgentRunResult JSON object."]
  );
}

function structuralProblems(result: AgentRunResult): string[] {
  const problems: string[] = [];
  if (!statuses.has(String(result.status))) {
    problems.push(`Unknown result status: ${String(result.status)}.`);
  }
  if (typeof result.message !== "string" || !result.message.trim()) {
    problems.push("Result message is missing.");
  }
  if (result.status === "succeeded" && result.stopReason && result.stopReason !== "passed") {
    problems.push(`Succeeded result has contradictory stop reason: ${result.stopReason}.`);
  }
  const contradictoryTests = (result.testResults ?? []).filter((test) => {
    const status = typeof test.status === "string" ? test.status.toLowerCase() : "";
    return ["passed", "success", "succeeded"].includes(status) &&
      typeof test.exitCode === "number" && test.exitCode !== 0;
  });
  if (contradictoryTests.length) {
    problems.push(`${contradictoryTests.length} test result(s) report success with a non-zero exit code.`);
  }
  const unsafeChangedFiles = (result.changedFiles ?? []).filter(isUnsafeRelativePath);
  if (unsafeChangedFiles.length) {
    problems.push(`Changed file paths must stay repository-relative: ${unsafeChangedFiles.join(", ")}.`);
  }
  return problems;
}

function blockedStopResult(
  result: AgentRunResult,
  providerName: string,
  problems: string[]
): AgentRunResult {
  const summary = `${providerName} stop validation blocked the result: ${problems.join(" ")}`;
  return {
    ...result,
    status: "waiting_human",
    message: `${result.message || `${providerName} returned an invalid result.`}\n\n${summary}`,
    comment: null,
    questions: ["Review the provider output and rerun the Agent job after correcting the result contract."],
    stopReason: "waiting_human",
    evidence: [
      ...(result.evidence ?? []),
      {
        type: "adapter_validation",
        title: "Provider stop validation blocked",
        summary,
        payload: { hook: "stop", provider: providerName, problems }
      }
    ],
    metadata: {
      ...(result.metadata ?? {}),
      nextLabel: null,
      pullRequest: null,
      adapterValidation: {
        hook: "stop",
        provider: providerName,
        passed: false,
        problems
      }
    }
  };
}

function normalizedStopReason(
  status: AgentRunResult["status"],
  stopReason: AgentStopReason | null | undefined
): AgentStopReason {
  if (status === "succeeded") return "passed";
  if (status === "waiting_human") return "waiting_human";
  if (status === "canceled") return "canceled";
  return stopReason && stopReason !== "passed" ? stopReason : "failed";
}

function isUnsafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]+/).some((part) => part === "..");
}
