import type { Grader, GraderInput, GraderResult } from "@microsoft/vally";
import { dirname, join } from "node:path";
import { parseScopeGraderConfig, type ScopeGraderConfig } from "./config.js";
import {
  SCOPE_RESULT_VERSION,
  type ScopeCriterionResult,
  type ScopeError,
  type ScopeGateResult,
  type ScopeResult,
} from "./contract.js";
import { preserveTrajectory, ScopeEvidenceError, type PreservedTrajectoryEvidence } from "./evidence.js";
import { blockedGate, DEFAULT_GATE_PROMPTS, initialGates, shouldExecuteRun, shouldExecuteTest } from "./gates.js";
import { createCopilotJudgeClient, type ScopeJudgeClient, type ScopeJudgeClientFactory } from "./judge-client.js";
import { analyzeBehavior, evaluateCriterion, evaluateGate, judgeErrorEvidence } from "./judging.js";
import { projectScopeResult } from "./projection.js";
import { IsolatedWorkspaceFactory } from "./workspace.js";

export interface ScopeGraderDependencies {
  clientFactory: ScopeJudgeClientFactory;
  preserveEvidence: typeof preserveTrajectory;
  createWorkspaceFactory: (source: string, artifacts: string) => IsolatedWorkspaceFactory;
  evaluateCriterion: typeof evaluateCriterion;
  evaluateGate: typeof evaluateGate;
  analyzeBehavior: typeof analyzeBehavior;
}

const DEFAULT_DEPENDENCIES: ScopeGraderDependencies = {
  clientFactory: createCopilotJudgeClient,
  preserveEvidence: preserveTrajectory,
  createWorkspaceFactory: (source, artifacts) => new IsolatedWorkspaceFactory(source, artifacts),
  evaluateCriterion,
  evaluateGate,
  analyzeBehavior,
};

function selectBlockedGate(
  name: "build" | "test" | "run",
  selectState: ScopeGateResult["state"],
): ScopeGateResult {
  return {
    name,
    state: "failed",
    reason: `${name} requires select to pass; select was ${selectState}`,
    evidence: [],
  };
}

function requireBuildOutcome(build: ScopeGateResult): ScopeGateResult {
  if (build.state !== "inapplicable") return build;
  return {
    ...build,
    state: "failed",
    reason: `Build is required for code scenarios: ${build.reason}`,
  };
}

function combineDefects(gates: ScopeGateResult[]): NonNullable<ScopeResult["outputMetrics"]>["defects"] {
  const groups = new Map<string, { category: string; count: number; description: string }>();
  for (const defect of gates.flatMap((gate) => gate.defects?.rootCauses ?? [])) {
    const key = `${defect.category}\0${defect.description}`;
    const existing = groups.get(key);
    groups.set(key, existing
      ? { ...existing, count: existing.count + defect.count }
      : structuredClone(defect));
  }
  const rootCauses = [...groups.values()].sort((left, right) =>
    right.count - left.count || left.category.localeCompare(right.category) ||
    left.description.localeCompare(right.description));
  return {
    rawCount: rootCauses.reduce((total, rootCause) => total + rootCause.count, 0),
    rootCauses,
  };
}

export class ScopeGrader implements Grader {
  readonly metadata = {
    name: "scope",
    description: "Composite per-run Scope evaluation over normalized Vally trajectories and isolated judge sessions",
    behavior: { requiresLlmClient: true, requiresWorkspace: true },
    determinism: "llm" as const,
    reference: "reference-free" as const,
    temporalScope: "trajectory-level" as const,
    costProfile: "high" as const,
  };

  constructor(private readonly dependencies: ScopeGraderDependencies = DEFAULT_DEPENDENCIES) {}

  defaultName(): string {
    return "scope";
  }

  async grade(input: GraderInput): Promise<GraderResult> {
    if (!input.trajectory) {
      return this.fatalError("Scope requires a trajectory", "capture", "response", "unknown");
    }

    let config: ScopeGraderConfig;
    try {
      config = parseScopeGraderConfig(input.config ?? {});
    } catch (error) {
      return this.fatalError(
        `Invalid Scope grader configuration: ${error instanceof Error ? error.message : String(error)}`,
        "infrastructure",
        "response",
        input.trajectory.id,
      );
    }

    const judgeRoot = input.trajectory.artifactDir ?? join(
      dirname(input.trajectory.workDir),
      `.scope-${input.trajectory.id}`,
    );
    let evidence: PreservedTrajectoryEvidence;
    try {
      evidence = await this.dependencies.preserveEvidence(
        input.trajectory,
        judgeRoot,
        input.diffBaseDir,
      );
    } catch (error) {
      const stage = error instanceof ScopeEvidenceError ? "evidence" : "capture";
      return this.fatalError(
        error instanceof Error ? error.message : String(error),
        stage,
        config.scenario_type,
        input.trajectory.id,
      );
    }

    const workspaceFactory = this.dependencies.createWorkspaceFactory(
      input.trajectory.workDir,
      judgeRoot,
    );
    try {
      await workspaceFactory.initialize();
    } catch (error) {
      return this.fatalError(
        `Could not snapshot the trial workspace: ${error instanceof Error ? error.message : String(error)}`,
        "infrastructure",
        config.scenario_type,
        input.trajectory.id,
      );
    }

    const errors: ScopeError[] = [];
    const gates = initialGates(config.scenario_type);
    const criteria: ScopeCriterionResult[] = [];
    let behaviorObservations: ScopeResult["behaviorObservations"] = [];
    let rootCauses: ScopeResult["rootCauses"] = [];
    const stimulusPrompt = resolveStimulusPrompt(input);
    const client = this.dependencies.clientFactory();
    let started = false;

    try {
      await client.start();
      started = true;

      const prerequisites = config.criteria.filter(
        (criterion) => criterion.classification === "prerequisite",
      );
      for (const [index, criterion] of prerequisites.entries()) {
        criteria.push(
          await this.runCriterion(
            client,
            workspaceFactory,
            criterion,
            config,
            index,
            stimulusPrompt,
            errors,
          ),
        );
      }

      const prerequisiteErrors = criteria.filter((criterion) => criterion.state === "error");
      const prerequisiteFailures = criteria.filter((criterion) => criterion.state !== "passed");
      gates.select = {
        name: "select",
        state: prerequisiteErrors.length > 0 ? "error" : prerequisiteFailures.length > 0 ? "failed" : "passed",
        reason:
          prerequisiteFailures.length === 0
            ? "All prerequisite criteria passed"
            : prerequisiteFailures.map((criterion) => `${criterion.name}: ${criterion.reason}`).join("; "),
        evidence: prerequisiteFailures.flatMap((criterion) => criterion.evidence),
      };

      if (config.scenario_type === "code") {
        if (gates.select.state === "passed") {
          const executionWorkspace = await workspaceFactory.create("execution-gates");
          gates.build = requireBuildOutcome(
            await this.runGate(client, workspaceFactory, "build", config, errors, executionWorkspace),
          );
          if (shouldExecuteTest(gates.build)) {
            gates.test = await this.runGate(client, workspaceFactory, "test", config, errors, executionWorkspace);
          } else {
            gates.test = blockedGate("test", "build", gates.build.state);
          }
          if (shouldExecuteRun(gates.build, gates.test)) {
            gates.run = await this.runGate(client, workspaceFactory, "run", config, errors, executionWorkspace);
          } else {
            gates.run = gates.build.state !== "passed"
              ? blockedGate("run", "build", gates.build.state)
              : blockedGate("run", "test", gates.test.state);
          }
        } else {
          gates.build = selectBlockedGate("build", gates.select.state);
          gates.test = selectBlockedGate("test", gates.select.state);
          gates.run = selectBlockedGate("run", gates.select.state);
        }
      }

      const remaining = config.criteria.filter(
        (criterion) => criterion.classification !== "prerequisite",
      );
      for (const [index, criterion] of remaining.entries()) {
        criteria.push(
          await this.runCriterion(
            client,
            workspaceFactory,
            criterion,
            config,
            prerequisites.length + index,
            stimulusPrompt,
            errors,
          ),
        );
      }

      if (config.behavior.enabled) {
        try {
          const behavior = await this.dependencies.analyzeBehavior(
            client,
            workspaceFactory,
            evidence,
            config.model,
            {
              instruction: stimulusPrompt,
              scenarioType: config.scenario_type,
              gates,
              criteria,
            },
          );
          behaviorObservations = behavior.behaviorObservations;
          rootCauses = behavior.rootCauses;
        } catch (error) {
          errors.push({
            stage: "judge",
            message: `Behavior analysis failed: ${error instanceof Error ? error.message : String(error)}`,
            affectsVerdict: false,
          });
        }
      }
    } catch (error) {
      errors.push({
        stage: "infrastructure",
        message: `Judge client failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      if (started) {
        try {
          await client.stop();
        } catch (error) {
          errors.push({
            stage: "infrastructure",
            message: `Judge client shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    const hasVerdictErrors = errors.some((error) => error.affectsVerdict !== false);
    const projection = projectScopeResult(criteria, hasVerdictErrors);
    const scope: ScopeResult = {
      schemaVersion: SCOPE_RESULT_VERSION,
      scenarioType: config.scenario_type,
      trajectoryId: input.trajectory.id,
      gates,
      criteria,
      eligibleForComparison: projection.eligibleForComparison,
      behaviorObservations,
      rootCauses,
      outputMetrics: {
        codeGenerated: Boolean(evidence.patch?.trim()),
        defects: combineDefects([gates.build, gates.test, gates.run]),
      },
      usage: evidence.usage,
      artifacts: evidence.references,
      errors,
      projection,
    };

    return {
      name: "scope",
      ...(hasVerdictErrors ? { status: "error" as const } : { status: "success" as const }),
      kind: "llm",
      passed: projection.passed,
      score: projection.score,
      label: hasVerdictErrors ? "error" : projection.passed ? "correct" : "incorrect",
      evidence: summarize(scope),
      details: [...Object.values(gates).map(gateDetail), ...criteria.map(criterionDetail)],
      metadata: { scope },
    };
  }

  private async runCriterion(
    client: ScopeJudgeClient,
    workspaceFactory: IsolatedWorkspaceFactory,
    criterion: ScopeGraderConfig["criteria"][number],
    config: ScopeGraderConfig,
    index: number,
    stimulusPrompt: string,
    errors: ScopeError[],
  ): Promise<ScopeCriterionResult> {
    try {
      return await this.dependencies.evaluateCriterion(
        client,
        workspaceFactory,
        criterion,
        config.model,
        index,
        stimulusPrompt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ stage: "judge", criterion: criterion.name, message });
      return {
        name: criterion.name,
        classification: criterion.classification,
        state: "error",
        reason: message,
        evidence: judgeErrorEvidence(message),
      };
    }
  }

  private async runGate(
    client: ScopeJudgeClient,
    workspaceFactory: IsolatedWorkspaceFactory,
    name: "build" | "test" | "run",
    config: ScopeGraderConfig,
    errors: ScopeError[],
    executionWorkspace: string,
  ): Promise<ScopeGateResult> {
    const prompt = name === "run"
      ? config.gates.run?.prompt
      : config.gates[name]?.prompt ?? DEFAULT_GATE_PROMPTS[name];
    try {
      return await this.dependencies.evaluateGate(
        client,
        workspaceFactory,
        name,
        prompt,
        config.model,
        executionWorkspace,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ stage: "judge", gate: name, message });
      return {
        name,
        state: "error",
        reason: message,
        ...(prompt ? { prompt } : {}),
        evidence: judgeErrorEvidence(message),
      };
    }
  }

  private fatalError(
    message: string,
    stage: ScopeError["stage"],
    scenarioType: ScopeResult["scenarioType"],
    trajectoryId: string,
  ): GraderResult {
    const gates = initialGates(scenarioType);
    gates.select = { name: "select", state: "error", reason: message, evidence: [] };
    const projection = projectScopeResult([], true);
    const scope: ScopeResult = {
      schemaVersion: SCOPE_RESULT_VERSION,
      scenarioType,
      trajectoryId,
      gates,
      criteria: [],
      eligibleForComparison: false,
      behaviorObservations: [],
      rootCauses: [],
      usage: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, trajectories: [] },
      artifacts: [],
      errors: [{ stage, message }],
      projection,
    };
    return {
      name: "scope",
      status: "error",
      kind: "llm",
      passed: false,
      score: 0,
      label: "error",
      evidence: message,
      metadata: { scope },
    };
  }
}

function resolveStimulusPrompt(input: GraderInput): string {
  const prompt = input.stimulus?.prompt ?? input.trajectory?.stimulus.prompt;
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? "");
}

function summarize(scope: ScopeResult): string {
  const passed = scope.criteria.filter((criterion) => criterion.state === "passed").length;
  return `Select ${scope.gates.select.state}; ${passed}/${scope.criteria.length} criteria passed; comparison eligible: ${scope.eligibleForComparison}; errors: ${scope.errors.length}`;
}

function gateDetail(gate: ScopeGateResult): GraderResult {
  return {
    name: `scope/gate/${gate.name}`,
    ...(gate.state === "error" ? { status: "error" as const } : {}),
    kind: "llm",
    passed: gate.state === "passed" || gate.state === "inapplicable",
    score: gate.state === "passed" ? 1 : 0,
    label: gate.state,
    evidence: gate.reason,
    metadata: { scopeGate: gate },
  };
}

function criterionDetail(criterion: ScopeCriterionResult): GraderResult {
  return {
    name: `scope/criterion/${criterion.name}`,
    ...(criterion.state === "error" ? { status: "error" as const } : {}),
    kind: "llm",
    passed: criterion.state === "passed",
    score: criterion.state === "passed" ? 1 : 0,
    label: criterion.state,
    evidence: criterion.reason,
    metadata: { scopeCriterion: criterion },
  };
}
