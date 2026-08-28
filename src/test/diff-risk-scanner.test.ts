import { describe, expect, it } from "vitest";
import { riskSignalsAtOrAbove, scanScoreManipulationRisks } from "../server/services/diff-risk-scanner";

describe("diff risk policy", () => {
  it("classifies signals by severity and applies the configured threshold", () => {
    const signals = scanScoreManipulationRisks([
      "diff --git a/src/app.ts b/src/app.ts",
      "+try { save(); } catch (error) { return; }",
      "+test.only('focused', () => {})"
    ].join("\n"));

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Error swallowed", severity: "medium" }),
        expect.objectContaining({ title: "Test skip added", severity: "high" })
      ])
    );
    expect(riskSignalsAtOrAbove(signals, "medium")).toHaveLength(2);
    expect(riskSignalsAtOrAbove(signals, "high").map((signal) => signal.title)).toEqual(["Test skip added"]);
    expect(riskSignalsAtOrAbove(signals, "none")).toEqual([]);
  });
});
