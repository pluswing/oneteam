import type { ActivityType, AgentJobDto, AgentJobStatus } from "../../shared/types";
import type { ObjectiveEvidenceRequirement } from "../../shared/evidence-requirements";

export type AgentActivityResult = {
  type: ActivityType;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
};

export type AgentStopReason =
  | "passed"
  | "failed"
  | "waiting_human"
  | "timeout"
  | "max_rounds_exceeded"
  | "budget_exceeded"
  | "risk_detected"
  | "rollback_required"
  | "canceled";

export type AgentEvidenceResult = {
  type: string;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
};

export type AgentRunResult = {
  status: Extract<AgentJobStatus, "succeeded" | "waiting_human" | "failed" | "canceled">;
  message: string;
  comment?: {
    targetType: "issue" | "pull_request";
    targetId: number;
    body: string;
    bodyFormat?: "markdown" | "html" | null;
  } | null;
  questions?: string[] | null;
  activities?: AgentActivityResult[] | null;
  changedFiles?: string[] | null;
  testResults?: Array<Record<string, unknown>> | null;
  stopReason?: AgentStopReason | null;
  evidence?: AgentEvidenceResult[] | null;
  metadata?: {
    nextLabel?: string | null;
    goalContract?: {
      evidenceRequired?: ObjectiveEvidenceRequirement[] | null;
    } | null;
    pullRequest?: {
      title: string;
      body?: string | null;
      sourceBranch: string;
      targetBranch: string;
      issueId?: number | null;
    } | null;
    review?: {
      verdict?: string | null;
      findings?: Array<Record<string, unknown>> | null;
      checked?: string[] | null;
    } | null;
    fix?: {
      resolvedFindings?: string[] | null;
      conflictVerification?: Record<string, unknown> | null;
    } | null;
    qa?: {
      verdict?: string | null;
      defects?: Array<Record<string, unknown>> | null;
      observations?: string[] | null;
    } | null;
    verifier?: {
      verdict?: string | null;
      stopConditionMet?: boolean | null;
      missingEvidence?: string[] | null;
      notes?: string[] | null;
    } | null;
    providerExecution?: {
      model?: string | null;
      sessionId?: string | null;
      resumedSession?: boolean | null;
      usage?: Record<string, unknown> | null;
    } | null;
    [key: string]: unknown;
  } | null;
};

export type ProviderCapacityProbeResult = {
  status: "available" | "exhausted" | "unknown";
  provider: AgentJobDto["aiProvider"];
  checkedAt: string;
  source: string;
  message: string;
  usageSnapshot: Record<string, unknown> | null;
  resetAt: string | null;
};

export type AgentAdapter = {
  run(input: {
    job: AgentJobDto;
    repoPath: string;
    prompt: string;
    deadlineAt?: string | null;
    onActivity?: (activity: AgentActivityResult) => Promise<void> | void;
    isCanceled?: () => Promise<boolean> | boolean;
  }): Promise<AgentRunResult>;
  probeCapacity?(input: {
    job: AgentJobDto;
    timeoutMs?: number;
  }): Promise<ProviderCapacityProbeResult | null>;
};
