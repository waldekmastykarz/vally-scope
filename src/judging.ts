import { approveAll, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { ScopeGraderConfig } from "./config.js";
import type {
  ScopeBehaviorObservation,
  ScopeCriterionResult,
  ScopeEvidenceReference,
  ScopeGateResult,
  ScopeRootCause,
} from "./contract.js";
import type { PreservedTrajectoryEvidence } from "./evidence.js";
import type { ScopeJudgeClient, ScopeJudgeSession } from "./judge-client.js";
import type { IsolatedWorkspaceFactory } from "./workspace.js";

const CRITERION_TIMEOUT_MS = 300_000;
const BEHAVIOR_TIMEOUT_MS = 600_000;
const EXECUTION_GATE_TIMEOUT_MS = 300_000;

const criterionVerdictSchema = z.object({
  result: z.enum(["pass", "fail"]),
  reason: z.string().min(1),
  evidence: z.array(
    z.object({
      path: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
});

const executionGateVerdictSchema = z.object({
  result: z.enum(["pass", "fail", "inapplicable"]),
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  defects: z.object({
    rawCount: z.number().int().nonnegative(),
    rootCauses: z.array(z.object({
      category: z.string().min(1),
      count: z.number().int().positive(),
      description: z.string().min(1),
    })),
  }),
});

const behaviorSchema = z.object({
  behaviorObservations: z.array(
    z.object({
      behavior: z.enum([
        "Discovered", "NotDiscovered", "LateDiscovery", "WrongDiscovery", "PartialDiscovery", "CompetingDiscovery",
        "CorrectInvocation", "MalformedInvocation", "SkippedInvocation", "Timeout",
        "RoutingFollowed", "RoutingNotFollowed", "WrongSubtoolCalled",
        "ContentMisused", "ContentIgnored",
        "CorrectOutcome", "CorrectButInefficient", "PartiallyCorrect", "HallucinatedOutcome", "WrongOutcome", "Blocked",
        "SuccessfulRecovery", "WrongRecovery", "NoRecovery",
      ]),
      category: z.enum(["Discovery", "Invocation", "Delegation", "Consumption", "Execution", "Recovery"]),
      extensionPointSurface: z.enum([
        "Skills", "MCPTools", "Instructions", "Documentation", "CLIAPISurface",
        "ErrorMessages", "AuthDeploymentFlows", "BaseModelKnowledge",
      ]),
      sourceArtifact: z.string(),
      evidence: z.string(),
      trajectoryId: z.string(),
      eventIndex: z.number().int().nonnegative(),
    }),
  ),
  rootCauses: z.array(
    z.object({
      label: z.string(),
      section: z.enum(["fix", "create", "constraint"]),
      source: z.string(),
      hostAssessment: z.object({
        status: z.enum(["suitable", "no-suitable-host", "not-applicable"]),
        artifact: z.string().optional(),
        rationale: z.string().min(1),
      }),
      affectedDimensions: z.array(
        z.enum(["idiomaticUse", "dependencyCurrency", "configurationCorrectness"]),
      ),
      behaviorChain: z.string(),
      evidence: z.string(),
      trajectoryId: z.string().optional(),
      eventIndex: z.number().int().nonnegative().optional(),
    }),
  ),
});

const CRITERION_SYSTEM_PROMPT = `You are a highly sophisticated automated coding agent with expert-level knowledge across many different programming languages and frameworks.
You will be given a criterion along with the user prompt. Your task is to evaluate the contents of a code project based on the provided criterion and return a binary PASS or FAIL result.

YOUR EVALUATION WORKFLOW (Follow these 4 steps in order):

STEP 1: ANALYZE THE CRITERION
- Read the criterion carefully
- Identify the specific checks needed for evaluation
- Determine what evidence would prove pass or fail

STEP 2: CREATE EVIDENCE COLLECTION PLAN
- Map each check to specific evidence locations (configuration files, source code, etc.)
- Determine which tools to use for each piece of evidence

STEP 3: GATHER EVIDENCE EFFICIENTLY
- Read complete relevant sections
- Use filesystem tools to discover and read files
- Collect ALL evidence before evaluating

STEP 4: EVALUATE AND RESPOND
- Apply evidence against the criterion
- Return a binary result: PASS or FAIL
- Provide a concise reason with concrete evidence (file paths, line numbers)

PASS/FAIL DECISION RULES:
- Return PASS when clear, concrete evidence fully satisfies the requirement
- Return FAIL when evidence contradicts the requirement, is incomplete, or nothing relevant exists

Call submit_verdict exactly once. Do not reveal or infer verdicts from any other criterion.`;

const BEHAVIOR_PROMPT = `You are an expert at analyzing coding agent behavior from a normalized Vally trajectory.

CRITICAL CLASSIFICATION RULE — Discovery vs. Invocation:
Discovery means an extension point is mentioned or referenced. Invocation means it is used via a function call or file read.

Behavior taxonomy:
- Discovery: Discovered, NotDiscovered, LateDiscovery, WrongDiscovery, PartialDiscovery, CompetingDiscovery
- Invocation: CorrectInvocation, MalformedInvocation, SkippedInvocation, Timeout
- Delegation: RoutingFollowed, RoutingNotFollowed, WrongSubtoolCalled
- Consumption: ContentMisused, ContentIgnored
- Execution: CorrectOutcome, CorrectButInefficient, PartiallyCorrect, HallucinatedOutcome, WrongOutcome, Blocked
- Recovery: SuccessfulRecovery, WrongRecovery, NoRecovery

Extension point surfaces: Skills, MCPTools, Instructions, Documentation, CLIAPISurface, ErrorMessages, AuthDeploymentFlows, BaseModelKnowledge.

Structural rules:
1. Discovery, Invocation, Delegation, and Consumption require a product extension point.
2. Execution is always applicable and exactly one Execution label is allowed.
3. Recovery applies only when a failure occurred.
4. BaseModelKnowledge is valid for Execution or when output came from training data without a product extension point; do not attribute Discovery, Invocation, Delegation, or Consumption to it.

Root-cause catalog:
- Authored content/fix: VocabularyMismatch, ContextOverflow, AmbiguousParameters, MissingUsageExamples, InstructionConflict, ResponseFormat, ConflictingSources, MissingAttribution, AmbiguousRoutingResponse, SubtoolVocabularyMismatch, IncorrectRouting, MissingDelegationInstructions, NoFallbackPath, MissingGroundingContent
- Core product/fix or create: HumanOnlySurface, MissingNonInteractiveMode, AuthComplexity, UnclearErrors, StateCorruption, MissingExtensionPoint, ToolLatency
- Model/constraint: StaleTrainingData, ToolOutputOverWeighting

Suitable-host rules:
- Inspect the target profile context, behavior observations, source attribution, and available artifact content.
- Use hostAssessment.status=suitable when an existing relevant artifact can host the fix, and identify it in hostAssessment.artifact.
- Use hostAssessment.status=no-suitable-host only when no relevant existing artifact can address the gap.
- Use hostAssessment.status=not-applicable only for a constraint that cannot be fixed through a profile artifact.
- section must be fix for a suitable host, create for no suitable host, and constraint for not applicable.
- The presence of an arbitrary extension is not enough to establish a suitable host.

Read trajectory.json and workspace.patch when present. Use the patch to understand the final workspace changes and the trajectory to understand how the agent produced them. The events array is zero-indexed. Every observation must cite the exact trajectoryId and eventIndex containing its evidence. Call submit_behavior exactly once.`;

export async function evaluateCriterion(
  client: ScopeJudgeClient,
  workspaceFactory: IsolatedWorkspaceFactory,
  criterion: ScopeGraderConfig["criteria"][number],
  model: string,
  index: number,
  stimulusPrompt: string,
): Promise<ScopeCriterionResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let session: ScopeJudgeSession | undefined;
    try {
      const workspace = await workspaceFactory.create(`criterion-${index}-${criterion.name}-attempt-${attempt}`);
      let verdict: z.infer<typeof criterionVerdictSchema> | undefined;
      const submitVerdict = defineTool("submit_verdict", {
        description: "Submit the independent binary verdict and concrete evidence for this criterion.",
        parameters: criterionVerdictSchema,
        skipPermission: true,
        handler: (args) => {
          verdict = args;
          return { ok: true };
        },
      });
      session = await client.createSession({
        model,
        onPermissionRequest: approveAll,
        workingDirectory: workspace,
        tools: [submitVerdict],
      });
      await session.sendAndWait(
        {
          prompt: `${CRITERION_SYSTEM_PROMPT}\n\nUser prompt: ${stimulusPrompt}\n\nCriterion: ${criterion.name}\nInstructions: ${criterion.instructions}\n\nExamine the workspace and call submit_verdict.`,
        },
        CRITERION_TIMEOUT_MS,
      );
      if (!verdict) throw new Error("Criterion judge did not call submit_verdict");
      return {
        name: criterion.name,
        classification: criterion.classification,
        state: verdict.result === "pass" ? "passed" : "failed",
        reason: verdict.reason,
        evidence: verdict.evidence.map((item) => ({
          kind: "judge" as const,
          ...(item.path ? { path: item.path } : {}),
          ...(item.description ? { description: item.description } : {}),
        })),
      };
    } catch (error) {
      lastError = error;
    } finally {
      if (session) {
        try {
          await session.disconnect();
        } catch {
          // Session cleanup must not replace a completed verdict or prevent the next attempt.
        }
      }
    }
  }
  throw new Error(
    `Failed to evaluate criterion ${criterion.name} after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function evaluateGate(
  client: ScopeJudgeClient,
  workspaceFactory: IsolatedWorkspaceFactory,
  name: "build" | "test" | "run",
  prompt: string | undefined,
  model: string,
  executionWorkspace?: string,
): Promise<ScopeGateResult> {
  const workspace = executionWorkspace ?? await workspaceFactory.create(`gate-${name}`);
  if ((name === "build" || name === "run") && prompt) {
    return evaluatePromptedExecutionGate(client, workspace, name, prompt, model);
  }
  const { executeGate } = await import("./gates.js");
  return executeGate(workspace, name, prompt);
}

async function evaluatePromptedExecutionGate(
  client: ScopeJudgeClient,
  workspace: string,
  name: "build" | "run",
  prompt: string,
  model: string,
): Promise<ScopeGateResult> {
  const label = name === "build" ? "Build" : "Run";
  const toolName = `submit_${name}_gate`;
  let verdict: z.infer<typeof executionGateVerdictSchema> | undefined;
  const submitVerdict = defineTool(toolName, {
    description: `Submit the ${label} gate verdict with concrete execution evidence.`,
    parameters: executionGateVerdictSchema,
    skipPermission: true,
    handler: (args) => {
      verdict = args;
      return { ok: true };
    },
  });
  const session = await client.createSession({
    model,
    onPermissionRequest: approveAll,
    workingDirectory: workspace,
    tools: [submitVerdict],
  });
  try {
    await session.sendAndWait({
      prompt: `Evaluate this project's ${label} gate against the following success criteria. Inspect the project and execute only the safe commands necessary to verify the criteria. Changes made by earlier execution gates persist in this workspace, including restored dependencies and generated build artifacts. Return inapplicable only when the criteria explicitly allow it and that condition is established. Count compiler, linter, and runtime error diagnostics from the commands you run in defects.rawCount, grouping repeated diagnostic codes or messages in defects.rootCauses. Use zero and an empty array when there are none. Call ${toolName} exactly once.\n\n${label} success criteria:\n${prompt}`,
    }, EXECUTION_GATE_TIMEOUT_MS);
    if (!verdict) throw new Error(`${label} gate judge did not call ${toolName}`);
    return {
      name,
      state: verdict.result === "pass" ? "passed" : verdict.result === "fail" ? "failed" : "inapplicable",
      reason: verdict.reason,
      prompt,
      defects: verdict.defects,
      evidence: verdict.evidence.map((description) => ({ kind: "judge", description })),
    };
  } finally {
    await session.disconnect();
  }
}

export async function analyzeBehavior(
  client: ScopeJudgeClient,
  workspaceFactory: IsolatedWorkspaceFactory,
  evidence: PreservedTrajectoryEvidence,
  model: string,
  context: Record<string, unknown>,
): Promise<{ behaviorObservations: ScopeBehaviorObservation[]; rootCauses: ScopeRootCause[] }> {
  const workspace = await workspaceFactory.create("behavior");
  const { copyFile, writeFile } = await import("node:fs/promises");
  const { basename, join } = await import("node:path");
  for (const reference of evidence.references) {
    if (reference.path && (reference.kind === "trajectory" || reference.kind === "diff")) {
      await copyFile(reference.path, join(workspace, basename(reference.path)));
    }
  }
  await writeFile(join(workspace, "scope-context.json"), `${JSON.stringify(context, null, 2)}\n`);
  const behaviorConstraint = describeBehaviorConstraint(context);

  let result: z.infer<typeof behaviorSchema> | undefined;
  const submitBehavior = defineTool("submit_behavior", {
    description: "Submit Scope behavior observations and root causes with exact Vally trajectory event identities.",
    parameters: behaviorSchema,
    skipPermission: true,
    handler: (args) => {
      result = args;
      return { ok: true };
    },
  });
  const session = await client.createSession({
    model,
    onPermissionRequest: approveAll,
    workingDirectory: workspace,
    tools: [submitBehavior],
  });
  try {
    await session.sendAndWait(
      { prompt: `${BEHAVIOR_PROMPT}\n\nRun context is in scope-context.json.${behaviorConstraint}` },
      BEHAVIOR_TIMEOUT_MS,
    );
    if (!result) throw new Error("Behavior judge did not call submit_behavior");
    const behaviorObservations = normalizeBehaviorObservations(
      result.behaviorObservations,
      behaviorConstraint.length === 0,
    );
    if (!behaviorObservations.some((observation) => observation.category === "Execution")) {
      throw new Error("Behavior judge returned no valid Execution observation");
    }
    validateBehaviorReferences(behaviorObservations, evidence);
    validateRootCauseReferences(result.rootCauses, evidence);
    validateHostAssessments(result.rootCauses);
    return {
      behaviorObservations,
      rootCauses: result.rootCauses.map((rootCause) => ({
        label: rootCause.label,
        section: rootCause.section,
        source: rootCause.source,
        hostAssessment: rootCause.hostAssessment,
        affectedDimensions: rootCause.affectedDimensions,
        behaviorChain: rootCause.behaviorChain,
        evidence: rootCause.evidence,
        ...(rootCause.trajectoryId ? { trajectoryId: rootCause.trajectoryId } : {}),
        ...(rootCause.eventIndex != null ? { eventIndex: rootCause.eventIndex } : {}),
      })),
    };
  } finally {
    await session.disconnect();
  }
}

function validateHostAssessments(rootCauses: Array<{
  label: string;
  section: "fix" | "create" | "constraint";
  hostAssessment: NonNullable<ScopeRootCause["hostAssessment"]>;
}>): void {
  for (const rootCause of rootCauses) {
    const expectedSection = rootCause.hostAssessment.status === "suitable"
      ? "fix"
      : rootCause.hostAssessment.status === "no-suitable-host"
        ? "create"
        : "constraint";
    if (rootCause.section !== expectedSection) {
      throw new Error(
        `Root cause ${rootCause.label} has section ${rootCause.section}, but host assessment requires ${expectedSection}`,
      );
    }
    if (rootCause.hostAssessment.status === "suitable" && !rootCause.hostAssessment.artifact) {
      throw new Error(`Root cause ${rootCause.label} identifies a suitable host without naming its artifact`);
    }
  }
}

function validateRootCauseReferences(
  rootCauses: Array<{ trajectoryId?: string | undefined; eventIndex?: number | undefined }>,
  evidence: PreservedTrajectoryEvidence,
): void {
  for (const rootCause of rootCauses) {
    if ((rootCause.trajectoryId == null) !== (rootCause.eventIndex == null)) {
      throw new Error("Behavior judge must provide both trajectoryId and eventIndex for root-cause identity");
    }
    if (
      rootCause.trajectoryId != null &&
      rootCause.eventIndex != null &&
      !isValidEventIdentity(rootCause.trajectoryId, rootCause.eventIndex, evidence)
    ) {
      throw new Error(
        `Behavior judge cited unknown root-cause trajectory identity ${rootCause.trajectoryId}:${rootCause.eventIndex}`,
      );
    }
  }
}

const BEHAVIOR_CATEGORY: Record<string, string> = {
  Discovered: "Discovery", NotDiscovered: "Discovery", LateDiscovery: "Discovery",
  WrongDiscovery: "Discovery", PartialDiscovery: "Discovery", CompetingDiscovery: "Discovery",
  CorrectInvocation: "Invocation", MalformedInvocation: "Invocation",
  SkippedInvocation: "Invocation", Timeout: "Invocation",
  RoutingFollowed: "Delegation", RoutingNotFollowed: "Delegation", WrongSubtoolCalled: "Delegation",
  ContentMisused: "Consumption", ContentIgnored: "Consumption",
  CorrectOutcome: "Execution", CorrectButInefficient: "Execution", PartiallyCorrect: "Execution",
  HallucinatedOutcome: "Execution", WrongOutcome: "Execution", Blocked: "Execution",
  SuccessfulRecovery: "Recovery", WrongRecovery: "Recovery", NoRecovery: "Recovery",
};

const EXECUTION_SEVERITY: Record<string, number> = {
  Blocked: 6,
  WrongOutcome: 5,
  HallucinatedOutcome: 4,
  PartiallyCorrect: 3,
  CorrectButInefficient: 2,
  CorrectOutcome: 1,
};

function normalizeBehaviorObservations(
  observations: ScopeBehaviorObservation[],
  allowCorrectExecution = true,
): ScopeBehaviorObservation[] {
  const valid = observations.filter((observation) => {
    if (BEHAVIOR_CATEGORY[observation.behavior] !== observation.category) return false;
    if (
      ["Discovery", "Invocation", "Delegation", "Consumption"].includes(observation.category) &&
      observation.extensionPointSurface === "BaseModelKnowledge"
    ) {
      return false;
    }
    if (
      !allowCorrectExecution &&
      observation.category === "Execution" &&
      ["CorrectOutcome", "CorrectButInefficient"].includes(observation.behavior)
    ) {
      return false;
    }
    return true;
  });
  const execution = valid
    .filter((observation) => observation.category === "Execution")
    .sort(
      (left, right) =>
        (EXECUTION_SEVERITY[right.behavior] ?? 0) - (EXECUTION_SEVERITY[left.behavior] ?? 0),
    )[0];
  return [...valid.filter((observation) => observation.category !== "Execution"), ...(execution ? [execution] : [])];
}

function describeBehaviorConstraint(context: Record<string, unknown>): string {
  const gates = isRecord(context.gates) ? context.gates : {};
  const criteria = Array.isArray(context.criteria) ? context.criteria : [];
  const failedGates = Object.entries(gates)
    .filter(([, gate]) => isRecord(gate) && ["failed", "error"].includes(String(gate.state)))
    .map(([name]) => name);
  const failedCriteria = criteria
    .filter((criterion) => isRecord(criterion) && criterion.state !== "passed")
    .map((criterion) => String(criterion.name ?? "unknown"));
  if (failedGates.length === 0 && failedCriteria.length === 0) return "";

  return `\n\nDETERMINISTIC CONSTRAINT: CorrectOutcome and CorrectButInefficient are invalid because verification did not fully pass.${
    failedGates.length > 0 ? ` Failed gates: ${failedGates.join(", ")}.` : ""
  }${failedCriteria.length > 0 ? ` Non-passing criteria: ${failedCriteria.join(", ")}.` : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBehaviorReferences(
  observations: ScopeBehaviorObservation[],
  evidence: PreservedTrajectoryEvidence,
): void {
  for (const observation of observations) {
    if (!isValidEventIdentity(observation.trajectoryId, observation.eventIndex, evidence)) {
      throw new Error(
        `Behavior judge cited unknown trajectory identity ${observation.trajectoryId}:${observation.eventIndex}`,
      );
    }
  }
}

function isValidEventIdentity(
  trajectoryId: string,
  eventIndex: number,
  evidence: PreservedTrajectoryEvidence,
): boolean {
  return trajectoryId === evidence.trajectory.id && eventIndex < evidence.trajectory.events.length;
}

export function judgeErrorEvidence(message: string): ScopeEvidenceReference[] {
  return [{ kind: "judge", description: message }];
}