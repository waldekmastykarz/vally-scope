import type { ScopeCriterionResult, ScopeProjection } from "./contract.js";

export function projectScopeResult(
  criteria: ScopeCriterionResult[],
  hasErrors = false,
): ScopeProjection {
  const prerequisites = criteria.filter(
    (criterion) => criterion.classification === "prerequisite",
  );
  const selectPassed =
    prerequisites.length > 0 && prerequisites.every((criterion) => criterion.state === "passed");
  const passedCriteria = criteria.filter((criterion) => criterion.state === "passed").length;
  const score = criteria.length === 0 ? 0 : passedCriteria / criteria.length;
  const eligibleForComparison = !hasErrors && selectPassed;
  const passed = !hasErrors && selectPassed;

  return {
    passed,
    score,
    selectPassed,
    eligibleForComparison,
    description:
      "Vally projection: infrastructure must succeed and Select must pass. The criterion pass fraction is reported as score but does not control pass/fail. Experiment reporting remains authoritative.",
  };
}
