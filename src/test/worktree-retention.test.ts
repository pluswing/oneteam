import { describe, expect, it } from "vitest";
import { decideWorktreeDisposition } from "../server/services/worktree-retention";

describe("worktree retention policy", () => {
  it("cleans terminal successful and canceled work", () => {
    expect(decideWorktreeDisposition("succeeded")).toEqual({ action: "cleanup", reason: "completed" });
    expect(decideWorktreeDisposition("canceled")).toEqual({ action: "cleanup", reason: "canceled" });
  });

  it("retains state needed for diagnosis or continuation", () => {
    expect(decideWorktreeDisposition("failed")).toEqual({ action: "retain", reason: "failed" });
    expect(decideWorktreeDisposition("runtime_error")).toEqual({ action: "retain", reason: "failed" });
    expect(decideWorktreeDisposition("waiting_human")).toEqual({ action: "retain", reason: "human_gate" });
    expect(decideWorktreeDisposition("waiting_provider")).toEqual({ action: "retain", reason: "provider_gate" });
    expect(decideWorktreeDisposition("paused")).toEqual({ action: "retain", reason: "paused" });
    expect(decideWorktreeDisposition("recoverable_error")).toEqual({
      action: "retain",
      reason: "recoverable_error"
    });
  });
});
