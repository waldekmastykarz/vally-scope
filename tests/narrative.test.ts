import { describe, expect, it, vi } from "vitest";
import { generateReadoutNarrative } from "../src/narrative.js";
import type { ScopeReporterManifest } from "../src/reporter-contract.js";

vi.mock("@github/copilot-sdk", () => ({
  approveAll: vi.fn(),
  defineTool: (_name: string, definition: Record<string, unknown>) => definition,
}));

function manifest(): ScopeReporterManifest {
  const baseline = { id: "baseline", name: "baseline", harness: "sdk", model: "claude-sonnet-5", extensions: [], isBaseline: true, environment: {} };
  const target = { id: "target", name: "target", harness: "sdk", model: "claude-sonnet-5", extensions: ["skill"], isBaseline: false, environment: {} };
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
      pricingSource: "https://example.test",
      pricingSha256: "fixture",
    },
    expected: { totalItems: 2, itemIds: ["baseline-item", "target-item"], missingCount: 0 },
    diagnostics: { duplicateItemIds: [], missingItemIds: [], messages: [] },
    profiles: [baseline, target],
    trials: [{
      itemId: "baseline-item",
      runId: "baseline-run",
      evalName: "eval",
      evalFilePath: "eval.yaml",
      variant: "baseline",
      stimulusName: "task",
      instruction: "do it",
      trialIndex: 0,
      totalTrials: 1,
      status: "success",
      durationMs: 1,
      profile: baseline,
      criteria: [],
      graderConfig: {},
      trajectoryMetadata: {},
      artifactRefs: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
      trajectoryEvents: [{ type: "baseline-evidence" }],
    }, {
      itemId: "target-item",
      runId: "target-run",
      evalName: "eval",
      evalFilePath: "eval.yaml",
      variant: "target",
      stimulusName: "task",
      instruction: "do it",
      trialIndex: 0,
      totalTrials: 1,
      status: "success",
      durationMs: 1,
      profile: target,
      criteria: [],
      graderConfig: {},
      trajectoryMetadata: {},
      artifactRefs: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
      trajectoryEvents: [{ type: "target-evidence" }],
    }],
  };
}

describe("generateReadoutNarrative", () => {
  it("captures structured output and always closes the session and client", async () => {
    const disconnect = vi.fn();
    const stop = vi.fn();
    const createSession = vi.fn(async (config: any) => ({
      disconnect,
      sendAndWait: async ({ prompt }: { prompt: string }) => {
        expect(prompt).toContain('"baselineProfileId": "baseline"');
        expect(prompt).toContain('"profileId": "baseline"');
        expect(prompt).toContain('"profileId": "target"');
        expect(prompt).toContain('"type": "baseline-evidence"');
        expect(prompt).toContain('"type": "target-evidence"');
        expect(prompt).toContain('"instruction": "do it"');
        expect(prompt).toContain('"rubric": []');
        expect(prompt).toContain("no target-profile change is recommended");
        expect(prompt).toContain("applicable gate below 100%");
        await config.tools[0].handler({
          keyFinding: "Finding",
          criteriaAnalysis: "Analysis",
          profileNarratives: { baseline: "Baseline narrative", target: "Target narrative" },
          actionNarrative: "No extension needed",
          summaryNarrative: "Summary",
          profileVerdicts: { baseline: "Baseline verdict", target: "Target verdict" },
          actions: { fix: [], create: [], constraints: [] },
        });
      },
    }));

    const result = await generateReadoutNarrative(manifest(), {
      model: "judge",
      clientFactory: () => ({ start: vi.fn(), stop, createSession }) as never,
    });

    expect(result.keyFinding).toBe("Finding");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "judge" }));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
