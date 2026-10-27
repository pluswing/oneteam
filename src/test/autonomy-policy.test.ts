import { expect, it, vi } from "vitest";
import { justifiedHumanHandoff, runWithAutonomy } from "../server/agents/autonomy-policy";
import type { AgentRunResult } from "../server/agents/types";

const job = { input: { developmentLoopId: 1 } };
const routine: AgentRunResult = { status: "waiting_human", message: "May I implement the agreed change?", questions: ["Proceed?"], stopReason: "waiting_human",
  metadata: { providerExecution: { usage: { input_tokens: 10, output_tokens: 3 } } } };
const blocked: AgentRunResult = { status: "waiting_human", stopReason: "waiting_human", message: "The required private registry credential is not available.", questions: ["Please configure the private registry credential and resume."],
  metadata: { humanHandoff: { reason: "external_access", blocker: "Registry returns 401", attemptedResolution: "Inspected the configured registry and attempted authenticated access using the existing environment.", whyHumanRequired: "No authorized credential is present and obtaining one requires the account owner." } } };
const setup = (...results: AgentRunResult[]) => ({ job, prompt: "Implement the requested feature", run: vi.fn<(prompt: string) => Promise<AgentRunResult>>().mockImplementation(async () => results.shift()!), onActivity: vi.fn(async () => {}), isCanceled: vi.fn(async () => false) });

it("reconsiders a routine confirmation once without changing the workspace or inventing an answer", async () => {
  const input = setup(routine, { status: "succeeded", message: "Implemented and tested", metadata: { providerExecution: { usage: { input_tokens: 20, output_tokens: 4 } } } });
  expect(await runWithAutonomy(input)).toMatchObject({ status: "succeeded", metadata: { autonomousContinuation: { attempts: 1 }, providerExecution: { usage: { inputTokens: 30, outputTokens: 7 } } } });
  expect(input.run).toHaveBeenCalledTimes(2);
  expect(input.run.mock.calls[1][0]).toContain("Do not replay completed commands or edits");
  expect(input.onActivity).toHaveBeenCalledWith(expect.objectContaining({ title: "Automatic continuation" }));
});

it("preserves a substantiated indispensable human handoff without repeatedly asking the model", async () => {
  expect(justifiedHumanHandoff(blocked)).toBe(true);
  const input = setup(blocked);
  expect(await runWithAutonomy(input)).toBe(blocked);
  expect(input.run).toHaveBeenCalledTimes(1);
});

it("permits a real blocker discovered during reassessment", async () => {
  const input = setup(routine, blocked);
  expect(await runWithAutonomy(input)).toMatchObject({ status: "waiting_human", metadata: { humanHandoff: blocked.metadata?.humanHandoff } });
  expect(input.run).toHaveBeenCalledTimes(2);
});

it("does not accept incomplete or unknown handoff reasons and never marks unfinished work successful", async () => {
  expect(justifiedHumanHandoff({ ...blocked, questions: [] })).toBe(false);
  expect(justifiedHumanHandoff({ ...blocked, metadata: { humanHandoff: { ...blocked.metadata!.humanHandoff!, attemptedResolution: "" } } })).toBe(false);
  const input = setup(routine, routine);
  expect(await runWithAutonomy(input)).toMatchObject({ status: "failed", questions: null, stopReason: "failed", metadata: { unsubstantiatedHandoff: true } });
  expect(input.run).toHaveBeenCalledTimes(2);
});

it.each(["risk_detected", "rollback_required", "budget_exceeded", "max_rounds_exceeded", "timeout"] as const)("preserves the %s boundary without attempting continuation", async (stopReason) => {
  const result = { ...routine, stopReason };
  const input = setup(result);
  expect(await runWithAutonomy(input)).toBe(result);
  expect(input.run).toHaveBeenCalledTimes(1);
});

it("preserves unsafe paths, explicit stops and legacy workflow semantics", async () => {
  const unsafe = { ...routine, metadata: { adapterValidation: { problems: ["Changed file paths must stay repository-relative: ../outside."] } } };
  const input = setup(unsafe);
  expect(await runWithAutonomy(input)).toBe(unsafe);
  expect(input.run).toHaveBeenCalledTimes(1);
  const canceled = setup(routine); canceled.isCanceled.mockResolvedValue(true);
  expect(await runWithAutonomy(canceled)).toBe(routine);
  expect(canceled.run).toHaveBeenCalledTimes(1);
  const legacy = { ...setup(routine), job: { ...job, input: {} } };
  expect(await runWithAutonomy(legacy)).toBe(routine);
  expect(legacy.run).toHaveBeenCalledTimes(1);
});

it("rechecks a pause that arrives while the continuation audit is being saved", async () => {
  const input = setup(routine);
  input.isCanceled.mockResolvedValueOnce(false).mockResolvedValue(true);
  expect(await runWithAutonomy(input)).toBe(routine);
  expect(input.run).toHaveBeenCalledTimes(1);
});
