import { describe, expect, it, vi } from "vitest";
import type { ScopeGraderConfig } from "../src/config.js";
import type { ScopeCriterionResult, ScopeGateResult } from "../src/contract.js";
import { ScopeGrader, type ScopeGraderDependencies } from "../src/grader.js";

function config(criteria: ScopeGraderConfig["criteria"]): Record<string, unknown> {
  return { model: "judge", scenario_type: "code", criteria, behavior: { enabled: true } };
}

const prerequisites = [
  { name: "Select", classification: "prerequisite" as const, instructions: "right product" },
];

function resultFor(
  criterion: ScopeGraderConfig["criteria"][number],
  state: ScopeCriterionResult["state"] = "passed",
): ScopeCriterionResult {
  return { name: criterion.name, classification: criterion.classification, state, reason: state, evidence: [] };
}

function gate(name: "build" | "test" | "run", state: ScopeGateResult["state"] = "passed"): ScopeGateResult {
  return { name, state, reason: state, evidence: [] };
}

function dependencies(overrides: Partial<ScopeGraderDependencies> = {}) {
  const client = { start: vi.fn(), stop: vi.fn(), createSession: vi.fn() };
  const workspaceFactory = {
    initialize: vi.fn(),
    create: vi.fn().mockResolvedValue("/isolated/execution-gates"),
  };
  const base: ScopeGraderDependencies = {
    clientFactory: () => client as never,
    preserveEvidence: vi.fn().mockResolvedValue({
      trajectory: { id: "trial", events: [] }, patch: "diff --git a/new.ts b/new.ts\n+export {};\n", directory: "/artifacts/scope/evidence", manifestPath: "/artifacts/scope/evidence/manifest.json",
      references: [], usage: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, trajectories: [] },
    }),
    createWorkspaceFactory: vi.fn(() => workspaceFactory as never),
    evaluateCriterion: vi.fn(async (_client, _factory, criterion) => resultFor(criterion)),
    evaluateGate: vi.fn(async (_client, _factory, name) => gate(name)),
    analyzeBehavior: vi.fn().mockResolvedValue({ behaviorObservations: [], rootCauses: [] }),
    ...overrides,
  };
  return { base, client, workspaceFactory };
}

function input(configuration: Record<string, unknown>) {
  return {
    config: configuration,
    stimulus: { name: "task", prompt: "do it" },
    trajectory: { id: "trial", workDir: "/workspace", artifactDir: "/artifacts", stimulus: { prompt: "do it" } },
  } as never;
}

describe("ScopeGrader", () => {
  it("judges remaining criteria after failed Select but excludes the run from comparison", async () => {
    const evaluate = vi.fn(async (_client, _factory, criterion: ScopeGraderConfig["criteria"][number]) =>
      resultFor(criterion, criterion.classification === "prerequisite" ? "failed" : "passed"),
    );
    const { base } = dependencies({ evaluateCriterion: evaluate as never });
    const grader = new ScopeGrader(base);
    const result = await grader.grade(
      input(config([...prerequisites, { name: "Quality", classification: "idiomaticUse", instructions: "good" }]))
    );
    const scope = result.metadata?.scope as any;

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(scope.criteria[1].state).toBe("passed");
    expect(scope.gates.select.state).toBe("failed");
    expect(scope.gates.build.state).toBe("failed");
    expect(base.evaluateGate).not.toHaveBeenCalled();
    expect(scope.eligibleForComparison).toBe(false);
    expect(base.analyzeBehavior).toHaveBeenCalledOnce();
    expect(result.passed).toBe(false);
  });

  it("passes shared criteria instructions to every criterion judge", async () => {
    const { base } = dependencies();
    const grader = new ScopeGrader(base);
    await grader.grade(input({
      ...config([...prerequisites, { name: "Quality", classification: "idiomaticUse", instructions: "good" }]),
      criteria_instructions: "shared rules",
    }));

    expect(base.evaluateCriterion).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(base.evaluateCriterion).mock.calls) {
      expect(call[6]).toBe("shared rules");
    }
  });

  it("evaluates Select before mechanical gates", async () => {
    const order: string[] = [];
    const evaluateCriterion = vi.fn(async (_client, _factory, criterion: ScopeGraderConfig["criteria"][number]) => {
      order.push(`criterion:${criterion.name}`);
      return resultFor(criterion);
    });
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") => {
      order.push(`gate:${name}`);
      return gate(name);
    });
    const { base } = dependencies({ evaluateCriterion: evaluateCriterion as never, evaluateGate: evaluateGate as never });

    await new ScopeGrader(base).grade(input(config(prerequisites)));

    expect(order).toEqual(["criterion:Select", "gate:build", "gate:test", "gate:run"]);
  });

  it("uses one persistent isolated workspace for Build, Test, and Run", async () => {
    const executionWorkspace = "/isolated/execution-gates";
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") =>
      gate(name, name === "test" ? "inapplicable" : "passed"),
    );
    const { base, workspaceFactory } = dependencies({ evaluateGate: evaluateGate as never });
    workspaceFactory.create.mockResolvedValue(executionWorkspace);

    await new ScopeGrader(base).grade(input(config(prerequisites)));

    expect(workspaceFactory.create).toHaveBeenCalledWith("execution-gates");
    expect(evaluateGate).toHaveBeenCalledTimes(3);
    expect(evaluateGate.mock.calls.every((call) => call[5] === executionWorkspace)).toBe(true);
  });

  it("derives code generation and defects from preserved deterministic evidence", async () => {
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") => ({
      ...gate(name),
      defects: name === "build"
        ? { rawCount: 2, rootCauses: [{ category: "TS2322", count: 2, description: "Type mismatch" }] }
        : { rawCount: 0, rootCauses: [] },
    }));
    const { base } = dependencies({ evaluateGate: evaluateGate as never });

    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));

    expect(result.metadata?.scope).toMatchObject({
      outputMetrics: {
        codeGenerated: true,
        defects: {
          rawCount: 2,
          rootCauses: [{ category: "TS2322", count: 2, description: "Type mismatch" }],
        },
      },
    });
  });

  it("uses zero-exit Run semantics when no Run prompt is configured", async () => {
    const { base } = dependencies();

    await new ScopeGrader(base).grade(input(config(prerequisites)));

    expect(base.evaluateGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run",
      undefined,
      "judge",
      "/isolated/execution-gates",
    );
  });

  it("records behavior analysis failures without invalidating the judge verdict", async () => {
    const { base } = dependencies({
      analyzeBehavior: vi.fn().mockRejectedValue(new Error("behavior unavailable")),
    });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;

    expect(result.status).toBe("success");
    expect(result.passed).toBe(true);
    expect(scope.errors[0]).toMatchObject({
      stage: "judge",
      affectsVerdict: false,
      message: "Behavior analysis failed: behavior unavailable",
    });
  });

  it("stops its per-grade judge client after successful evaluation", async () => {
    const { base, client } = dependencies();
    await new ScopeGrader(base).grade(input(config(prerequisites)));
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("places judge workspaces beside live workspaces when artifactDir is absent", async () => {
    const { base } = dependencies();
    const liveInput = input(config(prerequisites));
    delete liveInput.trajectory.artifactDir;

    await new ScopeGrader(base).grade(liveInput);

    expect(base.createWorkspaceFactory).toHaveBeenCalledWith(
      "/workspace",
      "/.scope-trial",
    );
  });

  it("blocks Test and Run when Build fails", async () => {
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") =>
      gate(name, name === "build" ? "failed" : "passed"),
    );
    const { base } = dependencies({ evaluateGate: evaluateGate as never });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;

    expect(evaluateGate).toHaveBeenCalledOnce();
    expect(scope.gates.test.state).toBe("failed");
    expect(scope.gates.run.state).toBe("failed");
  });

  it("converts an inapplicable Build into a cascading failure", async () => {
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") =>
      gate(name, name === "build" ? "inapplicable" : "passed"),
    );
    const { base } = dependencies({ evaluateGate: evaluateGate as never });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;

    expect(evaluateGate).toHaveBeenCalledOnce();
    expect(scope.gates.build).toMatchObject({
      state: "failed",
      reason: "Build is required for code scenarios: inapplicable",
    });
    expect(scope.gates.test.state).toBe("failed");
    expect(scope.gates.run.state).toBe("failed");
  });

  it("runs Run when Test is inapplicable", async () => {
    const evaluateGate = vi.fn(async (_client, _factory, name: "build" | "test" | "run") =>
      gate(name, name === "test" ? "inapplicable" : "passed"),
    );
    const { base } = dependencies({ evaluateGate: evaluateGate as never });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;

    expect(evaluateGate).toHaveBeenCalledTimes(3);
    expect(scope.gates.run.state).toBe("passed");
  });

  it("surfaces criterion judge errors without converting them to failures", async () => {
    const { base, client } = dependencies({
      evaluateCriterion: vi.fn().mockRejectedValue(new Error("judge unavailable")),
    });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;

    expect(result.status).toBe("error");
    expect(result.passed).toBe(false);
    expect(scope.criteria[0].state).toBe("error");
    expect(scope.errors[0]).toMatchObject({ stage: "judge", criterion: "Select" });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("returns a distinct capture error when trajectory evidence cannot be preserved", async () => {
    const { base } = dependencies({
      preserveEvidence: vi.fn().mockRejectedValue(new Error("capture unavailable")),
    });
    const result = await new ScopeGrader(base).grade(input(config(prerequisites)));
    const scope = result.metadata?.scope as any;
    expect(result.status).toBe("error");
    expect(scope.errors[0]).toMatchObject({ stage: "capture", message: "capture unavailable" });
  });
});
