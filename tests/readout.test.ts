import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ScopeResult } from "../src/contract.js";
import { calculateModelCost } from "../src/pricing.js";
import { buildReadout, validateReadoutSchema } from "../src/readout.js";
import type {
  ScopeReporterManifest,
  ScopeReporterProfile,
  ScopeReporterTrial,
} from "../src/reporter-contract.js";

const scopeFixture = JSON.parse(await readFile(
  new URL("./fixtures/scope-grader/scope-result.v2.json", import.meta.url),
  "utf8",
)) as ScopeResult;

const criteria = [
  { name: "Uses the requested text format", classification: "prerequisite" },
  { name: "Contains no unrelated output", classification: "idiomaticUse" },
];

function profile(id: string, isBaseline: boolean): ScopeReporterProfile {
  return {
    id,
    name: id,
    harness: "copilot-sdk",
    model: "Claude Sonnet 5",
    extensions: isBaseline ? [] : ["learn"],
    isBaseline,
    environment: {},
  };
}

function trial(
  itemId: string,
  trialProfile: ScopeReporterProfile,
  select: "passed" | "failed",
  inputTokens: number,
  quality: "passed" | "failed" = "passed",
): ScopeReporterTrial {
  const scope = structuredClone(scopeFixture);
  scope.trajectoryId = `trajectory-${itemId}`;
  scope.gates.select.state = select;
  scope.eligibleForComparison = select === "passed";
  scope.outputMetrics = {
    codeGenerated: true,
    defects: {
      rawCount: quality === "failed" ? 2 : 0,
      rootCauses: quality === "failed"
        ? [{ category: "TS2322", count: 2, description: "Type mismatch" }]
        : [],
    },
  };
  scope.criteria.push({
    name: "Contains no unrelated output",
    classification: "idiomaticUse",
    state: quality,
    reason: quality,
    evidence: [],
  });
  return {
    itemId,
    runId: `run-${itemId}`,
    evalName: "Scope fixture",
    evalFilePath: "fixtures/eval.yaml",
    variant: trialProfile.name,
    stimulusName: "scope-fixture",
    instruction: "Create answer.txt",
    trialIndex: 0,
    totalTrials: 2,
    status: "success",
    durationMs: 1_000,
    profile: trialProfile,
    criteria,
    graderConfig: { model: "judge", scenario_type: "code", criteria },
    trajectoryMetadata: { os: "macOS", reasoningEffort: "high" },
    scope,
    trajectoryRef: `trajectory-${itemId}`,
    artifactRefs: scope.artifacts,
    usage: {
      inputTokens,
      outputTokens: 100,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      requests: 1,
    },
    trajectoryEvents: [{ type: "tool_call" }, { type: "tool_result" }],
  };
}

function manifest(trials: ScopeReporterTrial[]): ScopeReporterManifest {
  return {
    schemaVersion: "1.0",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    status: "completed",
    finalization: { status: "pending" },
    provenance: {
      graderContract: "ScopeResult/2.0",
      readoutPolicy: "2026-09-11",
      pricingPolicy: "2026-09-11",
      pricingSource: "https://example.test/pricing",
      pricingSha256: "fixture",
    },
    expected: { totalItems: trials.length, itemIds: trials.map(({ itemId }) => itemId), missingCount: 0 },
    diagnostics: { duplicateItemIds: [], missingItemIds: [], messages: [] },
    profiles: [...new Map(trials.map(({ profile }) => [profile.id, profile])).values()],
    trials,
  };
}

describe("Scope readout", () => {
  it("matches the authoritative schema and excludes failed Select runs only from deltas", async () => {
    const bare = profile("bare", true);
    const extension = profile("learn", false);
    const readout = buildReadout(manifest([
      trial("bare-pass", bare, "passed", 1_000),
      trial("bare-select-fail", bare, "failed", 20_000),
      trial("learn-pass-1", extension, "passed", 2_000),
      trial("learn-pass-2", extension, "passed", 4_000),
    ]), { targetProfileId: extension.id }) as any;

    await expect(validateReadoutSchema(readout)).resolves.toBeUndefined();
    const bareResult = readout.scorecard.profileResults.find((result: any) => result.profileId === bare.id);
    const extensionResult = readout.scorecard.profileResults.find((result: any) => result.profileId === extension.id);
    expect(bareResult.select).toEqual({ passed: 1, total: 2 });
    expect(bareResult.score).toBeLessThan(extensionResult.score);
    expect(extensionResult.deltaTokens).toBe(2_000);
    expect(readout.behaviorAnalysis.profiles[0].behaviors[0].rate.total).toBe(2);
    expect(extensionResult.requests).toBe(1);
    expect(extensionResult.codeGenerationRate).toBe(1);
    expect(extensionResult.defects).toBe(0);
    expect(readout.runs[0].metadata).toMatchObject({
      graderConfig: { model: "judge" },
      trajectory: { os: "macOS", reasoningEffort: "high" },
    });
    expect(readout.runs[0].metadata).toHaveProperty("criterionEvidence.Uses the requested text format");
  });

  it("reports defect averages and Select-qualified defect deltas", () => {
    const bare = profile("bare", true);
    const extension = profile("learn", false);
    const bareFailed = trial("bare-failed", bare, "passed", 1_000, "failed");
    const bareSelectFailed = trial("bare-select", bare, "failed", 1_000, "failed");
    bareSelectFailed.scope!.outputMetrics!.defects.rawCount = 20;
    const extensionFailed = trial("learn-failed", extension, "passed", 1_000, "failed");
    extensionFailed.scope!.outputMetrics!.defects.rawCount = 1;
    extensionFailed.scope!.rootCauses = [{
      label: "MissingUsageExamples",
      section: "fix",
      source: "learn/SKILL.md",
      hostAssessment: { status: "suitable", artifact: "learn/SKILL.md", rationale: "The existing skill covers this task." },
      affectedDimensions: ["idiomaticUse"],
      behaviorChain: "The skill omitted the required output constraint.",
      evidence: "The generated workspace contained unrelated output.",
      trajectoryId: extensionFailed.scope!.trajectoryId,
      eventIndex: 1,
    }];
    const extensionPassed = trial("learn-pass", extension, "passed", 1_000);

    const readout = buildReadout(manifest([
      bareFailed,
      bareSelectFailed,
      extensionFailed,
      extensionPassed,
    ]), { targetProfileId: extension.id }) as any;
    const bareResult = readout.scorecard.profileResults.find((result: any) => result.profileId === bare.id);
    const extensionResult = readout.scorecard.profileResults.find((result: any) => result.profileId === extension.id);

    expect(bareResult.defects).toBe(11);
    expect(extensionResult.defects).toBe(0.5);
    expect(extensionResult.deltaDefects).toBe(-0.75);
    expect(readout.runs.find((run: any) => run.id === "run-learn-failed").results.defects.rawCount).toBe(1);
  });

  it("reports an all-inapplicable Test gate as N/A without reducing reliability", async () => {
    const bare = profile("bare", true);
    const trials = [
      trial("bare-1", bare, "passed", 1_000),
      trial("bare-2", bare, "passed", 1_000),
    ];
    for (const item of trials) {
      item.scope!.gates.build.state = "passed";
      item.scope!.gates.test.state = "inapplicable";
      item.scope!.gates.run.state = "passed";
    }

    const readout = buildReadout(manifest(trials)) as any;
    const result = readout.scorecard.profileResults[0];

    await expect(validateReadoutSchema(readout)).resolves.toBeUndefined();
    expect(result.test).toBe("N/A");
    expect(result.reliabilityScore).toBe(1);
  });

  it("uses only applicable runs in a mixed gate denominator", () => {
    const bare = profile("bare", true);
    const applicable = trial("bare-applicable", bare, "passed", 1_000);
    const inapplicable = trial("bare-inapplicable", bare, "passed", 1_000);
    applicable.scope!.gates.test.state = "passed";
    inapplicable.scope!.gates.test.state = "inapplicable";

    const readout = buildReadout(manifest([applicable, inapplicable])) as any;

    expect(readout.scorecard.profileResults[0].test).toEqual({ passed: 1, total: 1 });
  });

  it("rejects duplicate and missing trial results", () => {
    const bare = profile("bare", true);
    const invalid = manifest([trial("one", bare, "passed", 1_000)]);
    invalid.expected = { totalItems: 2, itemIds: ["one", "two"], missingCount: 1 };
    invalid.diagnostics.duplicateItemIds = ["one"];

    expect(() => buildReadout(invalid)).toThrow(/Duplicate trial results/);
  });

  it("prices uncached, cached, cache-write, and output tokens from the bundled policy", () => {
    expect(calculateModelCost("claude-sonnet-5", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    })).toBeCloseTo(0.002945, 8);
  });

  it("aggregates target-only actions by distinct affected run", async () => {
    const bare = profile("bare", true);
    const extension = profile("learn", false);
    const bareTrial = trial("bare", bare, "passed", 1_000);
    const failed = trial("learn", extension, "passed", 1_000, "failed");
    failed.scope!.rootCauses = [{
      label: "MissingUsageExamples",
      section: "fix",
      source: "learn/SKILL.md",
      hostAssessment: { status: "suitable", artifact: "learn/SKILL.md", rationale: "The existing skill covers this task." },
      affectedDimensions: ["idiomaticUse"],
      behaviorChain: "The skill omitted the required output constraint.",
      evidence: "The generated workspace contained an unrelated file.",
      trajectoryId: failed.scope!.trajectoryId,
      eventIndex: 1,
    }, {
      label: "MissingUsageExamples",
      section: "fix",
      source: "learn/SKILL.md",
      hostAssessment: { status: "suitable", artifact: "learn/SKILL.md", rationale: "The existing skill covers this task." },
      affectedDimensions: ["idiomaticUse"],
      behaviorChain: "The skill omitted the required output constraint.",
      evidence: "The same run confirms the missing guidance.",
      trajectoryId: failed.scope!.trajectoryId,
      eventIndex: 2,
    }];

    const readout = buildReadout(manifest([bareTrial, failed]), { targetProfileId: extension.id }) as any;
    await expect(validateReadoutSchema(readout)).resolves.toBeUndefined();
    expect(readout.actionList.fix).toHaveLength(1);
    expect(readout.actionList.fix[0]).toMatchObject({
      priority: 1,
      rootCause: "MissingUsageExamples",
      runs: { passed: 1, total: 1 },
      fixTarget: "learn/SKILL.md",
    });
    expect(readout.actionList.fix[0].description).toContain("Contains no unrelated output");
    expect(readout.actionList.fix[0].evidence.every((entry: any) => entry.runId === "run-learn")).toBe(true);
  });

  it("compares profiles that differ by model and selects the target by profile name", async () => {
    const modelProfile = (name: string, model: string, isBaseline: boolean): ScopeReporterProfile => ({
      ...profile(`eval.yaml--task--${name}--copilot-sdk--${model}`, isBaseline),
      name,
      model,
      extensions: [],
    });
    const opus = modelProfile("claude-opus-5.5", "claude-opus-5.5", true);
    const sol = modelProfile("gpt-6.1-sol", "gpt-6.1-sol", false);
    const astra = modelProfile("gpt-6-astra", "gpt-6-astra", false);
    const trials = [
      trial("astra", astra, "passed", 1_000),
      trial("opus", opus, "passed", 1_000),
      trial("sol", sol, "passed", 1_000),
    ];

    const readout = buildReadout(manifest(trials), { targetProfileId: "gpt-6.1-sol" }) as any;

    await expect(validateReadoutSchema(readout)).resolves.toBeUndefined();
    expect(readout.metadata.model).toBe("claude-opus-5.5");
    expect(readout.metadata.profiles.map((item: any) => item.model).sort())
      .toEqual(["claude-opus-5.5", "gpt-6-astra", "gpt-6.1-sol"]);
    expect(readout.scorecard.profileResults).toHaveLength(3);
    expect(() => buildReadout(manifest(trials))).toThrow(/target is ambiguous/);
    expect(() => buildReadout(manifest(trials), { targetProfileId: "gpt-5.6-sol" }))
      .toThrow(/Unknown target profile/);
  });

  it("rejects incompatible groups and ambiguous baselines", () => {
    const first = profile("first", false);
    const second = profile("second", false);
    const mismatched = trial("second", second, "passed", 1_000);
    mismatched.stimulusName = "different-task";

    expect(() => buildReadout(manifest([trial("first", first, "passed", 1_000), mismatched])))
      .toThrow(/exactly one compatible/);
    expect(() => buildReadout(manifest([
      trial("first", first, "passed", 1_000),
      trial("second", second, "passed", 1_000),
    ]))).toThrow(/exactly one bare baseline/);
  });

  it("rejects Create actions without an explicit no-suitable-host assessment", () => {
    const target = profile("target", true);
    const failed = trial("target", target, "passed", 1_000, "failed");
    failed.scope!.rootCauses = [{
      label: "MissingExtensionPoint",
      section: "create",
      source: "missing-guidance",
      affectedDimensions: ["idiomaticUse"],
      behaviorChain: "The target lacks guidance.",
      evidence: "No relevant artifact was found.",
    }];

    expect(() => buildReadout(manifest([failed]))).toThrow(/no-suitable-host assessment/);
  });
});
