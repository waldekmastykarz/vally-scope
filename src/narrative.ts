import { approveAll, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { createCopilotJudgeClient, type ScopeJudgeClientFactory } from "./judge-client.js";
import { calculateModelCost } from "./pricing.js";
import type { ReadoutNarrative } from "./readout.js";
import type { ScopeReporterManifest, ScopeReporterProfile } from "./reporter-contract.js";

const NARRATIVE_TIMEOUT_MS = 600_000;
export const READOUT_SYNTHESIS_POLICY_VERSION = "2026-09-14.1" as const;

const evidenceSchema = z.object({
  runId: z.string(),
  stepId: z.string().optional(),
  turnNumber: z.number().int().nonnegative().optional(),
  criterionName: z.string().optional(),
  excerpt: z.string().optional(),
});
const runsSchema = z.object({ passed: z.number().int().nonnegative(), total: z.number().int().positive() });
const narrativeSchema = z.object({
  keyFinding: z.string().min(1),
  criteriaAnalysis: z.string().min(1),
  profileNarratives: z.record(z.string(), z.string().min(1)),
  actionNarrative: z.string().min(1),
  summaryNarrative: z.string().min(1),
  profileVerdicts: z.record(z.string(), z.string().min(1)),
  actions: z.object({
    fix: z.array(z.object({
      priority: z.number().int().positive(),
      rootCause: z.string().min(1),
      runs: runsSchema,
      description: z.string().min(1),
      fixTarget: z.string().min(1),
      ownership: z.enum(["in_profile", "external_dependency"]).optional(),
      evidence: z.array(evidenceSchema),
    })),
    create: z.array(z.object({
      priority: z.number().int().positive(),
      gap: z.string().min(1),
      runs: runsSchema,
      whatToBuild: z.string().min(1),
      type: z.enum(["skill", "mcp_tool", "instructions", "docs"]).optional(),
      rationale: z.string().min(1),
      evidence: z.array(evidenceSchema),
    })),
    constraints: z.array(z.object({
      priority: z.number().int().positive(),
      rootCause: z.string().min(1),
      runs: runsSchema,
      description: z.string().min(1),
      affected: z.string().min(1),
      mitigation: z.string().optional(),
      evidence: z.array(evidenceSchema),
    })),
  }),
});

export interface NarrativeGenerationOptions {
  model: string;
  targetProfileId?: string;
  clientFactory?: ScopeJudgeClientFactory;
}

export async function generateReadoutNarrative(
  manifest: ScopeReporterManifest,
  options: NarrativeGenerationOptions,
): Promise<ReadoutNarrative> {
  const target = selectTarget(manifest.profiles, options.targetProfileId);
  const baseline = manifest.profiles.find((profile) => profile.isBaseline) ?? manifest.profiles[0]!;
  const targetTrials = manifest.trials.filter((trial) => trial.profile.id === target.id);
  const profileAggregates = manifest.profiles.map((profile) => {
    const trials = manifest.trials.filter((trial) => trial.profile.id === profile.id);
    const selectQualified = trials.filter((trial) => trial.scope?.gates.select.state === "passed");
    const criterionNames = [...new Set(trials.flatMap((trial) => trial.scope?.criteria
      .filter((criterion) => criterion.classification !== "prerequisite")
      .map((criterion) => criterion.name) ?? []))];
    return {
      profileId: profile.id,
      totalRuns: trials.length,
      selectPassed: selectQualified.length,
      avgTokens: mean(trials.map((trial) => trial.usage.inputTokens + trial.usage.outputTokens)),
      avgCostUsd: mean(trials.map((trial) => calculateModelCost(profile.model, trial.usage))),
      gates: Object.fromEntries((["select", "build", "test", "run"] as const).map((name) => {
        const applicable = trials.filter((trial) => trial.scope?.gates[name].state !== "inapplicable");
        return [name, applicable.length === 0 ? "N/A" : {
          passed: applicable.filter((trial) => trial.scope?.gates[name].state === "passed").length,
          total: applicable.length,
        }];
      })),
      criteria: criterionNames.map((name) => {
        const applicable = selectQualified.filter((trial) => trial.scope?.criteria
          .find((criterion) => criterion.name === name)?.state !== "inapplicable");
        const result = applicable.filter((trial) => trial.scope?.criteria
          .find((criterion) => criterion.name === name)?.state === "passed").length;
        return { name, passed: result, total: applicable.length };
      }),
    };
  });
  const baselineAggregate = profileAggregates.find((profile) => profile.profileId === baseline.id);
  const targetAggregate = profileAggregates.find((profile) => profile.profileId === target.id);
  const payload = {
    instruction: manifest.trials[0]?.instruction,
    rubric: manifest.trials[0]?.criteria ?? [],
    profiles: manifest.profiles.map(({ id, name, harness, model, extensions, isBaseline, environment }) => ({
      id, name, harness, model, extensions, isBaseline, environment,
    })),
    baselineProfileId: baseline.id,
    targetProfileId: target.id,
    targetRunCount: targetTrials.length,
    deterministicAggregates: profileAggregates,
    targetComparisons: targetAggregate?.criteria.map((criterion) => {
      const baselineCriterion = baselineAggregate?.criteria.find((candidate) => candidate.name === criterion.name);
      const targetRate = criterion.total === 0 ? undefined : criterion.passed / criterion.total;
      const baselineRate = !baselineCriterion || baselineCriterion.total === 0
        ? undefined
        : baselineCriterion.passed / baselineCriterion.total;
      const status = targetRate === 1 && baselineRate !== 1
        ? "addressed"
        : baselineRate != null && targetRate != null && targetRate > baselineRate
          ? "improved"
          : baselineRate != null && targetRate != null && targetRate < baselineRate
            ? "regressed"
            : "unchanged";
      return { criterion: criterion.name, status, baseline: baselineCriterion, target: criterion };
    }) ?? [],
    trialsByProfile: manifest.profiles.map((profile) => ({
      profileId: profile.id,
      trials: manifest.trials.filter((trial) => trial.profile.id === profile.id).map((trial) => ({
      runId: trial.runId,
      graderConfig: trial.graderConfig,
      criteria: trial.scope?.criteria,
      gates: trial.scope?.gates,
      behaviors: trial.scope?.behaviorObservations,
      rootCauses: trial.scope?.rootCauses,
      outputMetrics: trial.scope?.outputMetrics,
      errors: trial.scope?.errors,
      artifactRefs: trial.artifactRefs,
      trajectoryEvents: trial.trajectoryEvents,
      })),
    })),
  };
  let narrative: z.infer<typeof narrativeSchema> | undefined;
  const submitNarrative = defineTool("submit_scope_readout_narrative", {
    description: "Submit Scope readout prose and target-profile interventions.",
    parameters: narrativeSchema,
    skipPermission: true,
    handler: (value) => {
      narrative = value;
      return { ok: true };
    },
  });
  const client = (options.clientFactory ?? createCopilotJudgeClient)();
  await client.start();
  try {
    const session = await client.createSession({
      model: options.model,
      onPermissionRequest: approveAll,
      workingDirectory: process.cwd(),
      tools: [submitNarrative],
    });
    try {
      await session.sendAndWait({ prompt: `${NARRATIVE_PROMPT}\n\n${JSON.stringify(payload, null, 2)}` }, NARRATIVE_TIMEOUT_MS);
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
  if (!narrative) throw new Error("Readout narrative judge did not call submit_scope_readout_narrative");
  return narrative;
}

const NARRATIVE_PROMPT = `Create only the prose and Layer 3 interventions for a Scope structured readout.

Hard constraints:
- Never recompute or invent scores, pass rates, token counts, costs, or denominators.
- Synthesize experiment-wide patterns across every profile and run. Distinguish consistent behavior from isolated observations.
- Compare the target with baseline using targetComparisons. Explain addressed, improved, unchanged, and regressed criteria where they affect the conclusion.
- In keyFinding, identify a tie when top deterministic outcomes are equal; do not select a winner without a measured difference.
- In criteriaAnalysis, distinguish persistent failures across profiles, target improvements, target regressions, and universally passing criteria.
- For each profile narrative, state consistent behavior, skipped or misused extension points, and the execution outcome pattern. Use detailed trialsByProfile evidence, not aggregate rates alone.
- Layer 3 targets exactly targetProfileId. Every action evidence runId must belong to that profile's entry in trialsByProfile.
- Count distinct affected target run IDs. Every runs.total must equal targetRunCount.
- Cover every non-prerequisite target criterion below 100% in an action or evidence-backed constraint. Include the exact criterion name in that item.
- Do not emit actions for criteria at 100%.
- When target root causes do not explain a failed criterion, inspect that target run's behaviors, trajectory events, artifact references, and criterion evidence to derive an evidence-backed behavior chain and root cause.
- Extend a relevant existing target artifact before proposing a new one. Use create only when evidence shows no suitable host exists.
- Every create item must explain in rationale why the target's existing artifacts are unsuitable.
- Treat StaleTrainingData as a condition an extension may mitigate. Route it to a target artifact fix or a create action unless supplied evidence proves authored content cannot mitigate it.
- If every target criterion is at 100%, return empty action arrays and state that no target-profile change is recommended. Do not say only "No extension needed."
- In that no-action narrative, disclose any applicable gate below 100% in either target or baseline and any gate whose applicability differs between them. Explain that these gate outcomes affect the profile score but do not justify a target-profile intervention unless supplied target evidence supports one.
- Use only supplied evidence. Do not infer a root cause from pass rates alone.
- Treat apparent contradictions between criterion verdicts and trajectory evidence as evaluation uncertainty; do not turn them into unsupported product recommendations.
- Use profile environment, grader configuration, and artifact references when deciding whether the target already has a suitable host for a fix.
- Keep Layer 3 target-only even when another profile has failures. Use other profiles only for comparative context.
- Write one concise verdict per profile including Select performance and the most important measured outcome.
- Keep profile narratives and verdicts keyed by exact profile IDs.
- Call submit_scope_readout_narrative exactly once.`;

function selectTarget(profiles: ScopeReporterProfile[], requested?: string): ScopeReporterProfile {
  if (requested) {
    const target = profiles.find((profile) => profile.id === requested);
    if (!target) throw new Error(`Unknown target profile: ${requested}`);
    return target;
  }
  const baseline = profiles.find((profile) => profile.isBaseline);
  const alternatives = profiles.filter((profile) => profile.id !== baseline?.id);
  if (alternatives.length === 1) return alternatives[0]!;
  if (profiles.length === 1) return profiles[0]!;
  throw new Error("Layer 3 target is ambiguous; set targetProfileId");
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
