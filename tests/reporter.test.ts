import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeResult } from "../src/contract.js";
import { generateReadoutNarrative } from "../src/narrative.js";

vi.mock("../src/narrative.js", () => ({
  READOUT_SYNTHESIS_POLICY_VERSION: "test-policy",
  generateReadoutNarrative: vi.fn(async (manifest: any) => ({
    keyFinding: "Synthesized finding",
    criteriaAnalysis: "Synthesized criteria analysis",
    profileNarratives: Object.fromEntries(manifest.profiles.map((profile: any) => [
      profile.id,
      `Synthesized behavior for ${profile.name}`,
    ])),
    actionNarrative: "No extension needed",
    summaryNarrative: "Synthesized summary",
    profileVerdicts: Object.fromEntries(manifest.profiles.map((profile: any) => [
      profile.id,
      `Synthesized verdict for ${profile.name}`,
    ])),
    actions: { fix: [], create: [], constraints: [] },
  })),
}));

import {
  ScopeExperimentReporter,
  finalizeScopeReadout,
  finalizeScopeReadoutFromJsonl,
} from "../src/reporter.js";

const testRoot = join(process.cwd(), ".test-work", "scope-reporter");
const scopeFixture = JSON.parse(await readFile(
  new URL("./fixtures/scope-grader/scope-result.v2.json", import.meta.url),
  "utf8",
)) as ScopeResult;

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function item(id: string, variant: string, skills: string[] = []) {
  return {
    id,
    evalName: "scope-fixture",
    evalFilePath: "tests/fixtures/scope-grader/eval.yaml",
    variant,
    model: "claude-sonnet-5",
    stimulus: {
      name: "scope-fixture",
      prompt: "Create answer.txt",
      environment: { skills },
    },
    trialIndex: 0,
    totalTrials: 1,
    run: {
      executor: { name: "copilot-sdk" },
      graderConfigs: [{
        type: "scope",
        config: {
          criteria: [{
            name: "Uses the requested text format",
            classification: "prerequisite",
            instructions: "Use text.",
          }],
        },
      }],
    },
  } as never;
}

function result(id: string) {
  return {
    itemId: id,
    durationMs: 1_000,
    status: "success",
    grade: { metadata: { scope: structuredClone(scopeFixture) } },
    trajectory: {
      id: `trajectory-${id}`,
      metadata: {},
      metrics: {
        tokenUsage: {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          callCount: 1,
        },
      },
      events: [{ type: "tool_call", data: { toolName: "write" } }],
    },
  } as never;
}

describe("ScopeExperimentReporter", () => {
  it("collects out-of-order immutable results and finalizes a schema-valid readout", async () => {
    const reporter = new ScopeExperimentReporter({ outputDirectory: testRoot, baselineVariant: "bare" });
    const bare = item("item-bare", "bare");
    const learn = item("item-learn", "learn", ["learn"]);
    await reporter.onRunStart({ totalItems: 2, evals: [], workers: 2 } as never);
    await reporter.onTrialStart(bare);
    await reporter.onTrialStart(learn);
    const learnResult = result("item-learn");
    await reporter.onTrialResult({ item: learn, result: learnResult });
    learnResult.trajectory.events.length = 0;
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });
    await reporter.onRunComplete({ evals: [], passed: true, hadExecutionErrors: false }, { sessionLogsDir: testRoot }, "completed");

    const manifest = JSON.parse(await readFile(join(testRoot, "scope-readout.manifest.json"), "utf8"));
    expect(manifest.finalization.status).toBe("succeeded");
    expect(manifest.provenance.synthesis).toEqual({ model: "claude-opus-4.8", policy: "test-policy" });
    expect(manifest.trials.map((trial: any) => trial.itemId)).toEqual(["item-bare", "item-learn"]);
    expect(manifest.trials[1].trajectoryEvents).toHaveLength(1);
    expect(manifest.trials[1].profile.environment).toEqual({ skills: ["learn"] });
    expect(manifest.trials[1].graderConfig).toHaveProperty("criteria.0.instructions", "Use text.");
    const readout = JSON.parse(await readFile(join(testRoot, "readout.json"), "utf8"));
    expect(readout).toHaveProperty("actionList");
    expect(readout.scorecard.keyFinding).toBe("Synthesized finding");
    expect(readout.runs[1].metadata.environment).toEqual({ skills: ["learn"] });
    expect(readout.runs[1].metadata.criterionEvidence).toHaveProperty("Uses the requested text format");
  });

  it("records duplicate results and cancellation as a failed finalization sidecar", async () => {
    const reporter = new ScopeExperimentReporter({ outputDirectory: testRoot, baselineVariant: "bare" });
    const bare = item("item-bare", "bare");
    await reporter.onRunStart({ totalItems: 2, evals: [], workers: 1 } as never);
    await reporter.onTrialStart(bare);
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });
    await reporter.onRunComplete({ evals: [], passed: false, hadExecutionErrors: false }, { sessionLogsDir: testRoot }, "cancelled");

    const manifest = JSON.parse(await readFile(join(testRoot, "scope-readout.manifest.json"), "utf8"));
    expect(manifest.status).toBe("cancelled");
    expect(manifest.expected.missingCount).toBe(1);
    expect(manifest.diagnostics.duplicateItemIds).toEqual(["item-bare"]);
    expect(manifest.finalization).toMatchObject({ status: "failed", error: "Cannot finalize cancelled experiment" });
  });

  it("replays persisted JSONL using sidecar profile metadata", async () => {
    const collectionDir = join(testRoot, "collection");
    const replayDir = join(testRoot, "replay");
    const reporter = new ScopeExperimentReporter({ outputDirectory: collectionDir, baselineVariant: "bare" });
    const bare = item("item-bare", "bare");
    await reporter.onRunStart({ totalItems: 1, evals: [], workers: 1 } as never);
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });
    const manifest = reporter.createManifest("collecting");
    const manifestPath = join(collectionDir, "input-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const jsonlPath = join(collectionDir, "results.jsonl");
    await writeFile(jsonlPath, `${JSON.stringify({
      type: "trial-result",
      itemId: "item-bare",
      evalName: "scope-fixture",
      evalFilePath: "tests/fixtures/scope-grader/eval.yaml",
      variant: "bare",
      model: "claude-sonnet-5",
      stimulus: "scope-fixture",
      status: "success",
      durationMs: 1_000,
      gradeResult: { metadata: { scope: scopeFixture } },
      trajectory: {
        id: "trajectory-item-bare",
        stimulus: { prompt: "Create answer.txt" },
        metrics: { tokenUsage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 50, callCount: 1 } },
        events: [{ type: "tool_call" }],
      },
    })}\n`, "utf8");

    const finalized = await finalizeScopeReadoutFromJsonl(jsonlPath, manifestPath, { outputDirectory: replayDir });
    expect(finalized.status).toBe("succeeded");
    const readout = JSON.parse(await readFile(finalized.readoutPath!, "utf8"));
    expect(readout).toHaveProperty("runs.0.id", "trajectory-item-bare");
    expect(readout).toHaveProperty("runs.0.metadata.graderConfig.criteria.0.instructions", "Use text.");
  });

  it("persists schema-validation failures instead of throwing them away", async () => {
    const reporter = new ScopeExperimentReporter({ outputDirectory: testRoot, baselineVariant: "bare" });
    const bare = item("item-bare", "bare");
    await reporter.onRunStart({ totalItems: 1, evals: [], workers: 1 } as never);
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });
    const manifest = reporter.createManifest("completed");
    manifest.trials[0]!.profile.model = "unpriced-model";
    await writeFile(join(testRoot, "readout.json"), "stale", "utf8");

    const finalized = await finalizeScopeReadout(manifest, { outputDirectory: testRoot });
    expect(finalized).toMatchObject({ status: "failed", error: "No current pricing policy for model: unpriced-model" });
    const persisted = JSON.parse(await readFile(finalized.manifestPath, "utf8"));
    expect(persisted.finalization.status).toBe("failed");
    await expect(readFile(join(testRoot, "readout.json"), "utf8")).rejects.toThrow();
  });

  it("fails finalization when experiment-level synthesis fails", async () => {
    vi.mocked(generateReadoutNarrative).mockRejectedValueOnce(new Error("synthesis unavailable"));
    const reporter = new ScopeExperimentReporter({ outputDirectory: testRoot, baselineVariant: "bare" });
    const bare = item("item-bare", "bare");
    await reporter.onRunStart({ totalItems: 1, evals: [], workers: 1 } as never);
    await reporter.onTrialResult({ item: bare, result: result("item-bare") });

    await reporter.onRunComplete(
      { evals: [], passed: true, hadExecutionErrors: false },
      { sessionLogsDir: testRoot },
      "completed",
    );

    const manifest = JSON.parse(await readFile(join(testRoot, "scope-readout.manifest.json"), "utf8"));
    expect(manifest.finalization).toMatchObject({ status: "failed", error: "synthesis unavailable" });
    await expect(readFile(join(testRoot, "readout.json"), "utf8")).rejects.toThrow();
  });
});
