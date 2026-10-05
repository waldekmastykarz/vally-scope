import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScopeCriterionResult, ScopeRootCause } from "./contract.js";
import { calculateModelCost } from "./pricing.js";
import type {
  ScopeReporterCriterion,
  ScopeReporterManifest,
  ScopeReporterProfile,
  ScopeReporterTrial,
} from "./reporter-contract.js";

const POLICY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "references");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as typeof Ajv2020Class;
const addFormats = require("ajv-formats").default as FormatsPlugin;

export interface ReadoutNarrative {
  keyFinding: string;
  criteriaAnalysis: string;
  profileNarratives: Record<string, string>;
  actionNarrative: string;
  summaryNarrative: string;
  profileVerdicts: Record<string, string>;
  actions: {
    fix: unknown[];
    create: unknown[];
    constraints: unknown[];
  };
}

export interface ReadoutBuildOptions {
  targetProfileId?: string;
  narrative?: ReadoutNarrative;
}

export function buildReadout(manifest: ScopeReporterManifest, options: ReadoutBuildOptions = {}): Record<string, unknown> {
  assertCompleteManifest(manifest);
  const trials = [...manifest.trials].sort((left, right) => left.itemId.localeCompare(right.itemId));
  const groups = groupTrials(trials);
  if (groups.size !== 1) {
    throw new Error(`Scope readout requires exactly one compatible scenario/agent group; found ${groups.size}: ${[...groups.keys()].join("; ")}`);
  }
  const groupTrialsValue = [...groups.values()][0];
  if (!groupTrialsValue) throw new Error("Scope readout has no trials");
  const profileTrials = groupBy(groupTrialsValue, (trial) => trial.profile.id);
  const profiles = uniqueProfiles(groupTrialsValue);
  const baselines = profiles.filter((profile) => profile.isBaseline);
  if (profiles.length > 1 && baselines.length !== 1) {
    throw new Error(`Scope readout requires exactly one bare baseline for a multi-profile group; found ${baselines.length}`);
  }
  const baseline = baselines[0] ?? profiles[0]!;
  const target = selectTarget(profiles, baseline, options.targetProfileId);
  const criteria = assertConsistentRubric(groupTrialsValue);
  const profileResults = profiles.map((profile) => profileResult(
    profile,
    profileTrials.get(profile.id) ?? [],
    profile.id === baseline.id ? undefined : profileTrials.get(baseline.id),
    criteria,
  ));
  const deterministicActions = aggregateActions(profileTrials.get(target.id) ?? [], criteria);
  const narrative = options.narrative ?? deterministicNarrative(profiles, profileResults, target, baseline, deterministicActions);
  const actions = normalizeActionArithmetic(narrative.actions, profileTrials.get(target.id) ?? [], criteria);
  const readout = {
    metadata: buildMetadata(manifest.createdAt, groupTrialsValue, profiles, baseline, criteria),
    scorecard: {
      keyFinding: narrative.keyFinding,
      criteriaAnalysis: narrative.criteriaAnalysis,
      profileResults,
      criteriaBreakdowns: profiles.flatMap((profile) => {
        const scoped = profileTrials.get(profile.id) ?? [];
        return scoped.some(selectPassed) ? [criteriaBreakdown(profile.id, scoped, criteria)] : [];
      }),
    },
    behaviorAnalysis: {
      profiles: profiles.map((profile) => ({
        profileId: profile.id,
        narrative: narrative.profileNarratives[profile.id] ?? "No behavior narrative was generated.",
        behaviors: aggregateBehaviors(profileTrials.get(profile.id) ?? []),
      })),
    },
    actionList: {
      narrative: narrative.actionNarrative,
      fix: actions.fix,
      create: actions.create,
      constraints: actions.constraints,
    },
    summary: {
      narrative: narrative.summaryNarrative,
      profileVerdicts: profiles.map((profile) => ({
        profileId: profile.id,
        verdict: narrative.profileVerdicts[profile.id] ?? "No verdict was generated.",
      })),
    },
    runs: groupTrialsValue.map(toReadoutRun),
  };
  validateReadout(readout);
  validateActionCoverage(readout, target, profileTrials.get(target.id) ?? [], criteria);
  return readout;
}

export async function loadReadoutSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(POLICY_ROOT, "readout.schema.json"), "utf8")) as Record<string, unknown>;
}

export async function validateReadoutSchema(readout: unknown): Promise<void> {
  const schema = await loadReadoutSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(readout)) {
    throw new Error(`Readout schema validation failed: ${JSON.stringify(validate.errors)}`);
  }
}

function validateReadout(readout: Record<string, unknown>): void {
  if (!readout.metadata || !readout.scorecard || !readout.behaviorAnalysis || !readout.actionList) {
    throw new Error("Readout is missing a required layer");
  }
}

export function assertCompleteManifest(manifest: ScopeReporterManifest): void {
  if (manifest.status !== "completed") throw new Error(`Cannot finalize ${manifest.status} experiment`);
  if (manifest.diagnostics.duplicateItemIds.length > 0) {
    throw new Error(`Duplicate trial results: ${manifest.diagnostics.duplicateItemIds.join(", ")}`);
  }
  if (manifest.expected.missingCount > 0 || manifest.diagnostics.missingItemIds.length > 0) {
    throw new Error(`Experiment is partial: ${manifest.expected.missingCount} trial result(s) missing`);
  }
  if (manifest.trials.some((trial) => !trial.scope)) throw new Error("Every completed trial must contain a Scope grader result");
}

function groupTrials(trials: ScopeReporterTrial[]): Map<string, ScopeReporterTrial[]> {
  return groupBy(trials, (trial) => [trial.evalFilePath, trial.stimulusName, trial.profile.harness].join(" | "));
}

export function findProfile(profiles: ScopeReporterProfile[], requested: string): ScopeReporterProfile {
  const byId = profiles.find((profile) => profile.id === requested);
  if (byId) return byId;
  const byName = profiles.filter((profile) => profile.name === requested);
  if (byName.length === 1) return byName[0]!;
  throw new Error(byName.length === 0
    ? `Unknown target profile: ${requested}`
    : `Target profile name is ambiguous: ${requested}; use a profile ID`);
}

function selectTarget(
  profiles: ScopeReporterProfile[],
  baseline: ScopeReporterProfile,
  requested?: string,
): ScopeReporterProfile {
  if (requested) return findProfile(profiles, requested);
  if (profiles.length === 1) return profiles[0]!;
  const alternatives = profiles.filter((profile) => profile.id !== baseline.id);
  if (alternatives.length === 1) return alternatives[0]!;
  throw new Error(`Layer 3 target is ambiguous; choose one of: ${alternatives.map((profile) => profile.id).join(", ")}`);
}

function assertConsistentRubric(trials: ScopeReporterTrial[]): ScopeReporterCriterion[] {
  const canonical = JSON.stringify(trials[0]?.criteria ?? []);
  if (trials.some((trial) => JSON.stringify(trial.criteria) !== canonical)) {
    throw new Error("Cannot pool trials with different Scope rubrics");
  }
  return trials[0]?.criteria ?? [];
}

function buildMetadata(
  createdAt: string,
  trials: ScopeReporterTrial[],
  profiles: ScopeReporterProfile[],
  baseline: ScopeReporterProfile,
  criteria: ScopeReporterCriterion[],
): Record<string, unknown> {
  const first = trials[0]!;
  const counts = new Set(profiles.map((profile) => trials.filter((trial) => trial.profile.id === profile.id).length));
  if (counts.size !== 1) throw new Error("Profiles have different repetition counts; refusing an incomplete comparison");
  return {
    title: first.evalName,
    date: createdAt.slice(0, 10),
    scenarioType: first.scope!.scenarioType,
    runsPerProfile: [...counts][0],
    model: baseline.model,
    harness: baseline.harness,
    instruction: first.instruction,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      harness: profile.harness,
      model: profile.model,
      extensions: profile.extensions,
      isBaseline: profile.isBaseline,
    })),
    criteria,
  };
}

function profileResult(
  profile: ScopeReporterProfile,
  trials: ScopeReporterTrial[],
  baselineTrials: ScopeReporterTrial[] | undefined,
  criteria: ScopeReporterCriterion[],
): Record<string, unknown> {
  const gateNames = ["select", "build", "test", "run"] as const;
  const gates = Object.fromEntries(gateNames.map((name) => {
    const states = trials.map((trial) => trial.scope!.gates[name].state);
    const applicable = states.filter((state) => state !== "inapplicable");
    return [name, applicable.length === 0
      ? "N/A"
      : { passed: applicable.filter((state) => state === "passed").length, total: applicable.length }];
  }));
  const qualityCriteria = criteria.filter((criterion) => criterion.classification !== "prerequisite");
  const gateRates = Object.values(gates).filter(
    (rate): rate is { passed: number; total: number } => rate !== "N/A",
  );
  const gatePasses = gateRates.reduce((sum, rate) => sum + rate.passed, 0);
  const gateTotal = gateRates.reduce((sum, rate) => sum + rate.total, 0);
  let criterionPasses = 0;
  let criterionTotal = 0;
  for (const trial of trials) {
    for (const criterion of qualityCriteria) {
      const result = scopeCriterion(trial, criterion.name);
      if (result?.state === "inapplicable") continue;
      criterionTotal++;
      if (selectPassed(trial) && result?.state === "passed") criterionPasses++;
    }
  }
  const allChecks = gateTotal + criterionTotal;
  const allTokens = trials.map(totalTokens);
  const allCosts = trials.map(priceTrial);
  const allDefects = trials.map(defectCount);
  const comparable = trials.filter(selectPassed);
  const baselineComparable = baselineTrials?.filter(selectPassed);
  const score = allChecks === 0 ? 0 : (gatePasses + criterionPasses) / allChecks;
  const result: Record<string, unknown> = {
    profileId: profile.id,
    runIds: trials.map((trial) => trial.runId),
    score,
    qualityScore: criterionTotal === 0 ? 0 : criterionPasses / criterionTotal,
    reliabilityScore: gateTotal === 0 ? 0 : gatePasses / gateTotal,
    deltaLift: baselineTrials ? score - profileScore(baselineTrials, criteria) : null,
    deltaTokens: baselineTrials ? delta(mean(comparable.map(totalTokens)), mean(baselineComparable!.map(totalTokens)), true) : null,
    deltaDefects: baselineTrials
      ? relativeDelta(mean(comparable.map(defectCount)), mean(baselineComparable!.map(defectCount)))
      : null,
    tokens: Math.round(mean(allTokens) ?? 0),
    avgCostUsd: mean(allCosts) ?? 0,
    deltaCostUsd: baselineTrials ? delta(mean(comparable.map(priceTrial)), mean(baselineComparable!.map(priceTrial))) : null,
    requests: round(mean(trials.map(toolCallCount)) ?? 0, 1),
    ...(trials[0]?.scope?.scenarioType === "code" ? {
      defects: round(mean(allDefects) ?? 0, 1),
      codeGenerationRate: trials.filter((trial) => trial.scope!.outputMetrics?.codeGenerated === true).length /
        trials.length,
    } : {}),
    select: gates.select,
    ...gates,
  };
  return result;
}

function profileScore(trials: ScopeReporterTrial[], criteria: ScopeReporterCriterion[]): number {
  return Number(profileResult(trials[0]!.profile, trials, undefined, criteria).score);
}

function criteriaBreakdown(
  profileId: string,
  trials: ScopeReporterTrial[],
  criteria: ScopeReporterCriterion[],
): Record<string, unknown> {
  const eligible = trials.filter(selectPassed);
  const dimensions = groupBy(criteria.filter((criterion) => criterion.classification !== "prerequisite"), (criterion) => criterion.classification);
  return {
    profileId,
    dimensions: [...dimensions.entries()].map(([name, groupedCriteria]) => {
      const perRunPassed = eligible.filter((trial) => groupedCriteria.every((criterion) => scopeCriterion(trial, criterion.name)?.state === "passed")).length;
      return {
        name,
        passRate: { passed: perRunPassed, total: eligible.length },
        criteria: groupedCriteria.map((criterion) => {
          const applicable = eligible.filter((trial) => scopeCriterion(trial, criterion.name)?.state !== "inapplicable");
          if (applicable.length === 0) return undefined;
          return {
            description: criterion.name,
            passRate: {
              passed: applicable.filter((trial) => scopeCriterion(trial, criterion.name)?.state === "passed").length,
              total: applicable.length,
            },
            evidence: applicable.map((trial) => ({
              runId: trial.runId,
              criterionName: criterion.name,
              excerpt: criterionEvidenceExcerpt(scopeCriterion(trial, criterion.name)),
            })),
          };
        }).filter((criterion) => criterion !== undefined),
      };
    }).filter((dimension) => dimension.criteria.length > 0),
  };
}

function aggregateBehaviors(trials: ScopeReporterTrial[]): unknown[] {
  const observations = trials.flatMap((trial) => trial.scope!.behaviorObservations.map((observation) => ({ trial, observation })));
  const groups = groupBy(observations, ({ observation }) => [
    observation.behavior,
    observation.category,
    observation.extensionPointSurface,
    normalizeSource(observation.sourceArtifact),
  ].join("\0"));
  return [...groups.values()].map((entries) => {
    const first = entries[0]!;
    const runIds = new Set(entries.map(({ trial }) => trial.runId));
    return {
      category: first.observation.category.toLowerCase(),
      behavior: first.observation.behavior,
      rate: { passed: runIds.size, total: trials.length },
      surface: first.observation.extensionPointSurface,
      source: normalizeSource(first.observation.sourceArtifact),
      evidence: entries.map(({ trial, observation }) => ({
        runId: trial.runId,
        turnNumber: observation.eventIndex,
        excerpt: observation.evidence,
      })),
    };
  });
}

function toReadoutRun(trial: ScopeReporterTrial): Record<string, unknown> {
  return {
    id: trial.runId,
    profileId: trial.profile.id,
    name: `${trial.evalName} - ${trial.profile.name}`,
    status: trial.status === "success" ? "Done" : trial.status === "skipped" ? "Cancelled" : "Failed",
    ...(trial.trajectoryRef ? { trajectoryRef: trial.trajectoryRef } : {}),
    metadata: {
      environment: trial.profile.environment,
      graderConfig: trial.graderConfig,
      trajectory: trial.trajectoryMetadata,
      criterionEvidence: Object.fromEntries(trial.scope!.criteria.map((criterion) => [
        criterion.name,
        criterion.evidence,
      ])),
      artifacts: trial.artifactRefs,
      usage: trial.usage,
    },
    results: {
      durations: { codingSeconds: trial.durationMs / 1000 },
      tokens: totalTokens(trial),
      requests: toolCallCount(trial),
      ...(trial.scope!.scenarioType === "code" ? {
        codeGenerated: trial.scope!.outputMetrics?.codeGenerated ?? false,
        defects: trial.scope!.outputMetrics?.defects ?? { rawCount: 0, rootCauses: [] },
      } : {}),
      gates: Object.fromEntries(Object.entries(trial.scope!.gates).map(([name, gate]) => [name, { status: gateStatus(gate.state) }])),
      criteriaResults: Object.fromEntries(trial.scope!.criteria.map((criterion) => [criterion.name, {
        result: criterion.state === "passed" ? "pass" : criterion.state === "failed" ? "fail" : "skipped",
        reason: criterion.reason,
        ...(criterionEvidenceLocation(criterion) ? { trajectoryRef: criterionEvidenceLocation(criterion) } : {}),
      }])),
      behaviorObservations: trial.scope!.behaviorObservations.map((observation) => ({
        behavior: observation.behavior,
        category: observation.category,
        extensionPointSurface: observation.extensionPointSurface,
        sourceArtifact: observation.sourceArtifact,
        evidence: observation.evidence,
        turnNumber: observation.eventIndex,
      })),
      rootCauses: trial.scope!.rootCauses.map((rootCause) => ({
        label: rootCause.label,
        section: rootCause.section,
        source: rootCause.source,
        affectedDimensions: rootCause.affectedDimensions,
        behaviorChain: rootCause.behaviorChain,
        evidence: rootCause.evidence,
      })),
      reason: trial.error ?? trial.skipReason ?? "Evaluation completed",
    },
  };
}

function validateActionCoverage(
  readout: Record<string, any>,
  target: ScopeReporterProfile,
  targetTrials: ScopeReporterTrial[],
  criteria: ScopeReporterCriterion[],
): void {
  const targetRunIds = new Set(targetTrials.map((trial) => trial.runId));
  for (const section of ["fix", "create", "constraints"] as const) {
    for (const action of readout.actionList[section] ?? []) {
      if (action.runs.passed > action.runs.total || action.runs.total !== targetTrials.length) {
        throw new Error(`Invalid affected-run count in ${section} action`);
      }
      for (const evidence of action.evidence ?? []) {
        if (!targetRunIds.has(evidence.runId)) throw new Error(`Action evidence is not from target profile ${target.id}`);
      }
    }
  }
  const unresolved = criteria.filter((criterion) => {
    if (criterion.classification === "prerequisite") return false;
    const eligible = targetTrials.filter(selectPassed);
    return eligible.some((trial) => scopeCriterion(trial, criterion.name)?.state !== "passed");
  });
  const actionText = JSON.stringify(readout.actionList).toLowerCase();
  for (const criterion of unresolved) {
    if (!actionText.includes(criterion.name.toLowerCase())) {
      throw new Error(`Layer 3 does not cover unresolved target criterion: ${criterion.name}`);
    }
  }
}

function aggregateActions(
  targetTrials: ScopeReporterTrial[],
  criteria: ScopeReporterCriterion[],
): ReadoutNarrative["actions"] {
  const unresolvedDimensions = new Set(criteria.filter((criterion) => {
    if (criterion.classification === "prerequisite") return false;
    const eligible = targetTrials.filter(selectPassed);
    return eligible.some((trial) => scopeCriterion(trial, criterion.name)?.state !== "passed");
  }).map((criterion) => criterion.classification));
  const grouped = groupBy(targetTrials.flatMap((trial) => trial.scope!.rootCauses
    .filter((rootCause) => rootCause.affectedDimensions.some((dimension) => unresolvedDimensions.has(dimension)))
    .map((rootCause) => ({ trial, rootCause }))), ({ rootCause }) => [
      rootCause.label,
      rootCause.section,
      normalizeSource(rootCause.source),
    ].join("\0"));
  const ranked = [...grouped.values()].map((entries) => ({
    entries,
    score: new Set(entries.map(({ trial }) => trial.runId)).size *
      new Set(entries.flatMap(({ rootCause }) => rootCause.affectedDimensions)).size,
  })).sort((left, right) => right.score - left.score || actionKey(left.entries[0]!).localeCompare(actionKey(right.entries[0]!)));
  const actions: ReadoutNarrative["actions"] = { fix: [], create: [], constraints: [] };
  ranked.forEach(({ entries }, index) => {
    const first = entries[0]!;
    const runIds = new Set(entries.map(({ trial }) => trial.runId));
    const evidence = entries.map(({ trial, rootCause }) => actionEvidence(rootCause, trial));
    const runs = { passed: runIds.size, total: targetTrials.length };
    const affectedCriteria = [...new Set(entries.flatMap(({ trial, rootCause }) => criteria
      .filter((criterion) => rootCause.affectedDimensions.includes(criterion.classification as never))
      .filter((criterion) => scopeCriterion(trial, criterion.name)?.state === "failed")
      .map((criterion) => criterion.name)))];
    const criterionContext = affectedCriteria.length > 0 ? ` Affects: ${affectedCriteria.join(", ")}.` : "";
    const hostAssessment = first.rootCause.hostAssessment;
    if (first.rootCause.section === "create" && hostAssessment?.status !== "no-suitable-host") {
      throw new Error(
        `Create action ${first.rootCause.label} lacks an explicit no-suitable-host assessment`,
      );
    }
    if (first.rootCause.section === "fix") {
      actions.fix.push({
        priority: index + 1,
        rootCause: first.rootCause.label,
        runs,
        description: `${mergeText(entries.map(({ rootCause }) => rootCause.behaviorChain))}${criterionContext}`,
        fixTarget: normalizeSource(hostAssessment?.artifact ?? first.rootCause.source),
        ownership: "in_profile",
        evidence,
      });
    } else if (first.rootCause.section === "create") {
      actions.create.push({
        priority: index + 1,
        gap: `${normalizeSource(first.rootCause.source)}${criterionContext}`,
        runs,
        whatToBuild: mergeText(entries.map(({ rootCause }) => rootCause.behaviorChain)),
        rationale: hostAssessment!.rationale,
        evidence,
      });
    } else {
      actions.constraints.push({
        priority: index + 1,
        rootCause: first.rootCause.label,
        runs,
        description: `${mergeText(entries.map(({ rootCause }) => rootCause.behaviorChain))}${criterionContext}`,
        affected: [...new Set(entries.flatMap(({ rootCause }) => rootCause.affectedDimensions))].join(", "),
        evidence,
      });
    }
  });
  return actions;
}

function normalizeActionArithmetic(
  actions: ReadoutNarrative["actions"],
  targetTrials: ScopeReporterTrial[],
  criteria: ScopeReporterCriterion[],
): ReadoutNarrative["actions"] {
  const targetRunIds = new Set(targetTrials.map((trial) => trial.runId));
  const ranked = (["fix", "create", "constraints"] as const).flatMap((section) =>
    actions[section].map((value) => {
      const action = structuredClone(value) as Record<string, any>;
      const evidence = Array.isArray(action.evidence) ? action.evidence : [];
      const affected = new Set<string>();
      for (const item of evidence) {
        if (!targetRunIds.has(item.runId)) {
          throw new Error(`Action evidence is not from the selected target profile: ${String(item.runId)}`);
        }
        affected.add(item.runId);
      }
      if (affected.size === 0) throw new Error(`Every ${section} action must cite target-profile evidence`);
      action.runs = { passed: affected.size, total: targetTrials.length };
      const actionText = JSON.stringify(action).toLowerCase();
      const affectedDimensions = new Set(criteria
        .filter((criterion) => actionText.includes(criterion.name.toLowerCase()))
        .map((criterion) => criterion.classification));
      return {
        section,
        action,
        impact: affected.size * Math.max(1, affectedDimensions.size),
      };
    }),
  ).sort((left, right) => right.impact - left.impact || JSON.stringify(left.action).localeCompare(JSON.stringify(right.action)));
  ranked.forEach((entry, index) => {
    entry.action.priority = index + 1;
  });
  return {
    fix: ranked.filter(({ section }) => section === "fix").map(({ action }) => action),
    create: ranked.filter(({ section }) => section === "create").map(({ action }) => action),
    constraints: ranked.filter(({ section }) => section === "constraints").map(({ action }) => action),
  };
}

function deterministicNarrative(
  profiles: ScopeReporterProfile[],
  results: Array<Record<string, unknown>>,
  target: ScopeReporterProfile,
  baseline: ScopeReporterProfile,
  actions: ReadoutNarrative["actions"],
): ReadoutNarrative {
  const ranked = [...results].sort((left, right) => Number(right.score) - Number(left.score));
  const best = profiles.find((profile) => profile.id === ranked[0]?.profileId) ?? baseline;
  return {
    keyFinding: `${best.name} has the highest deterministic Scope score.`,
    criteriaAnalysis: "Criterion pass rates are reported by profile and Select-qualified cohort.",
    profileNarratives: Object.fromEntries(profiles.map((profile) => [profile.id, "Behavior observations are aggregated from all runs, including Select failures."])),
    actionNarrative: `This action list targets ${target.name} and compares it with ${baseline.name}. No extension needed unless unresolved target criteria have evidence-backed actions.`,
    summaryNarrative: "The scorecard reports deterministic aggregation; no additional narrative diagnosis was requested.",
    profileVerdicts: Object.fromEntries(profiles.map((profile) => [profile.id, `${profile.name}: Select and pooled checks reported above.`])),
    actions,
  };
}

function actionKey(entry: { rootCause: ScopeRootCause }): string {
  return [entry.rootCause.label, entry.rootCause.section, normalizeSource(entry.rootCause.source)].join("\0");
}

function mergeText(values: string[]): string {
  return [...new Set(values.filter(Boolean))].join(" ");
}

function priceTrial(trial: ScopeReporterTrial): number {
  return calculateModelCost(trial.profile.model, trial.usage);
}

function totalTokens(trial: ScopeReporterTrial): number {
  return trial.usage.inputTokens + trial.usage.outputTokens;
}

function defectCount(trial: ScopeReporterTrial): number {
  return trial.scope?.outputMetrics?.defects.rawCount ?? 0;
}

function toolCallCount(trial: ScopeReporterTrial): number {
  return trial.trajectoryEvents.filter((event) => {
    if (!event || typeof event !== "object") return false;
    return (event as { type?: unknown }).type === "tool_call";
  }).length;
}

function selectPassed(trial: ScopeReporterTrial): boolean {
  return trial.scope?.gates.select.state === "passed";
}

function scopeCriterion(trial: ScopeReporterTrial, name: string): ScopeCriterionResult | undefined {
  return trial.scope?.criteria.find((criterion) => criterion.name === name);
}

function criterionEvidenceExcerpt(criterion: ScopeCriterionResult | undefined): string {
  if (!criterion) return "Criterion result is missing";
  const evidence = criterion.evidence.flatMap((reference) => {
    const location = reference.path ?? (
      reference.trajectoryId && reference.eventIndex != null
        ? `${reference.trajectoryId}:${reference.eventIndex}`
        : undefined
    );
    const detail = [location, reference.description].filter(Boolean).join(": ");
    return detail ? [detail] : [];
  });
  return [criterion.reason, ...evidence].join(" | ");
}

function criterionEvidenceLocation(criterion: ScopeCriterionResult): string | undefined {
  for (const reference of criterion.evidence) {
    if (reference.path) return reference.path;
    if (reference.trajectoryId && reference.eventIndex != null) {
      return `${reference.trajectoryId}:${reference.eventIndex}`;
    }
  }
  return undefined;
}

function gateStatus(state: string): "pass" | "fail" | "na" | "skipped" {
  if (state === "passed") return "pass";
  if (state === "failed" || state === "error") return "fail";
  if (state === "inapplicable") return "na";
  return "skipped";
}

function normalizeSource(source: string): string {
  return source.trim().replaceAll("\\", "/");
}

function uniqueProfiles(trials: ScopeReporterTrial[]): ScopeReporterProfile[] {
  const profiles = new Map<string, ScopeReporterProfile>();
  for (const trial of trials) profiles.set(trial.profile.id, trial.profile);
  return [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), value]);
  }
  return groups;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function delta(value: number | undefined, baseline: number | undefined, integer = false): number | null {
  if (value == null || baseline == null) return null;
  const result = value - baseline;
  return integer ? Math.round(result) : result;
}

function relativeDelta(value: number | undefined, baseline: number | undefined): number | null {
  if (value == null || baseline == null || baseline === 0) return null;
  return (value - baseline) / baseline;
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function actionEvidence(rootCause: ScopeRootCause, trial: ScopeReporterTrial): Record<string, unknown> {
  return {
    runId: trial.runId,
    ...(rootCause.eventIndex != null ? { turnNumber: rootCause.eventIndex } : {}),
    excerpt: rootCause.evidence,
  };
}
