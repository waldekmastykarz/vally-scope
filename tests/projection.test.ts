import { describe, expect, it } from "vitest";
import type { ScopeCriterionResult } from "../src/contract.js";
import { projectScopeResult } from "../src/projection.js";

function criterion(
  name: string,
  classification: ScopeCriterionResult["classification"],
  state: ScopeCriterionResult["state"],
): ScopeCriterionResult {
  return { name, classification, state, reason: state, evidence: [] };
}

describe("projectScopeResult", () => {
  it("fails and excludes a run when Select fails", () => {
    const result = projectScopeResult(
      [
        criterion("select", "prerequisite", "failed"),
        criterion("quality", "idiomaticUse", "prerequisite-blocked"),
      ],
    );

    expect(result).toMatchObject({ passed: false, score: 0, eligibleForComparison: false });
  });

  it("passes on Select alone regardless of downstream criterion failures", () => {
    const result = projectScopeResult(
      [
        criterion("select", "prerequisite", "passed"),
        criterion("quality", "idiomaticUse", "failed"),
      ],
    );

    expect(result).toMatchObject({ passed: true, score: 0.5, eligibleForComparison: true });
  });

  it("reports all criteria in the score without using it as a pass threshold", () => {
    const result = projectScopeResult(
      [
        criterion("select", "prerequisite", "passed"),
        criterion("quality", "idiomaticUse", "passed"),
        criterion("currency", "dependencyCurrency", "failed"),
        criterion("config", "configurationCorrectness", "failed"),
      ],
    );

    expect(result).toMatchObject({ passed: true, score: 0.5 });
  });

  it("fails when grading infrastructure reports an error", () => {
    const result = projectScopeResult(
      [criterion("select", "prerequisite", "passed")],
      true,
    );

    expect(result).toMatchObject({
      passed: false,
      selectPassed: true,
      eligibleForComparison: false,
    });
  });
});
