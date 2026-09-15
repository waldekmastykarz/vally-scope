import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PlanReporter,
  PlanRunStartContext,
  ReporterRegistry,
  RunArtifacts,
  RunCompletionStatus,
  RunSummary,
  TrialResult,
  TrialWorkItem,
} from "@microsoft/vally";
import type { ScopeResult } from "./contract.js";
import { AtifTrajectoryReporter } from "./atif-reporter.js";
import { GradeResultReporter } from "./grade-result-reporter.js";
import { generateReadoutNarrative, READOUT_SYNTHESIS_POLICY_VERSION } from "./narrative.js";
import { pricingPolicySha256 } from "./pricing.js";
import {
  PRICING_POLICY_VERSION,
  READOUT_POLICY_VERSION,
  SCOPE_REPORTER_MANIFEST_VERSION,
  type ScopeFinalizationResult,
  type ScopeFinalizeOptions,
  type ScopeReporterCriterion,
  type ScopeReporterManifest,
  type ScopeReporterProfile,
  type ScopeReporterTrial,
} from "./reporter-contract.js";
import { assertCompleteManifest, buildReadout, validateReadoutSchema } from "./readout.js";
import { findFinalTrialDirectories } from "./trial-output.js";

const MANIFEST_NAME = "scope-readout.manifest.json";
const READOUT_NAME = "readout.json";

export interface ScopeReporterOptions {
  outputDirectory?: string;
  targetProfileId?: string;
  baselineVariant?: string;
  judgeModel?: string;
}

export class ScopeExperimentReporter implements PlanReporter {
  private context?: PlanRunStartContext;
  private readonly trials = new Map<string, ScopeReporterTrial>();
  private readonly duplicates = new Set<string>();
  private readonly started = new Set<string>();

  constructor(private readonly options: ScopeReporterOptions = {}) {}

  async onRunStart(context: PlanRunStartContext): Promise<void> {
    this.context = structuredClone(context);
    await this.checkpoint();
  }

  async onTrialStart(item: TrialWorkItem): Promise<void> {
    this.started.add(item.id);
  }

  async onTrialResult(event: { item: TrialWorkItem; result: TrialResult }): Promise<void> {
    if (this.trials.has(event.item.id)) {
      this.duplicates.add(event.item.id);
      await this.checkpoint();
      return;
    }
    this.trials.set(event.item.id, collectTrial(event.item, event.result, this.options.baselineVariant));
    await this.checkpoint();
  }

  async onRunComplete(
    _summary: RunSummary,
    artifacts: RunArtifacts,
    status: RunCompletionStatus = "completed",
  ): Promise<void> {
    const outputDirectory = this.options.outputDirectory ?? artifacts.sessionLogsDir ??
      (artifacts.jsonl ? dirname(artifacts.jsonl) : process.cwd());
    const manifest = this.createManifest(status);
    if (artifacts.sessionLogsDir) {
      await linkAtifTrajectories(manifest, artifacts.sessionLogsDir, outputDirectory);
    }
    await finalizeScopeReadout(manifest, {
      outputDirectory,
      ...(this.options.targetProfileId ? { targetProfileId: this.options.targetProfileId } : {}),
      ...(this.options.judgeModel ? { judgeModel: this.options.judgeModel } : {}),
    });
  }

  createManifest(status: ScopeReporterManifest["status"] = "completed"): ScopeReporterManifest {
    const now = new Date().toISOString();
    const expectedTotal = this.context?.totalItems ?? this.trials.size;
    const receivedIds = new Set(this.trials.keys());
    const missingStarted = [...this.started].filter((itemId) => !receivedIds.has(itemId)).sort();
    return {
      schemaVersion: SCOPE_REPORTER_MANIFEST_VERSION,
      createdAt: now,
      updatedAt: now,
      status,
      finalization: { status: "pending" },
      provenance: {
        graderContract: "ScopeResult/2.0",
        readoutPolicy: READOUT_POLICY_VERSION,
        pricingPolicy: PRICING_POLICY_VERSION,
        pricingSource: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
        pricingSha256: pricingPolicySha256,
        ...(this.context?.source ? { producer: this.context.source } : {}),
      },
      expected: {
        totalItems: expectedTotal,
        itemIds: [...this.started].sort(),
        missingCount: Math.max(0, expectedTotal - this.trials.size),
      },
      diagnostics: {
        duplicateItemIds: [...this.duplicates].sort(),
        missingItemIds: missingStarted,
        messages: status === "completed" ? [] : [`Experiment ended with status ${status}`],
      },
      profiles: uniqueProfiles([...this.trials.values()]),
      trials: [...this.trials.values()].sort((left, right) => left.itemId.localeCompare(right.itemId)),
    };
  }

  private async checkpoint(): Promise<void> {
    if (!this.options.outputDirectory) return;
    await mkdir(this.options.outputDirectory, { recursive: true });
    await writeJsonAtomic(join(this.options.outputDirectory, MANIFEST_NAME), this.createManifest("collecting"));
  }
}

async function linkAtifTrajectories(
  manifest: ScopeReporterManifest,
  sessionLogsDirectory: string,
  readoutDirectory: string,
): Promise<void> {
  const trialDirectories = await findFinalTrialDirectories(sessionLogsDirectory);
  for (const trial of manifest.trials) {
    const trialDirectory = trialDirectories.get(trial.itemId);
    if (!trialDirectory) continue;
    trial.trajectoryRef = relative(readoutDirectory, join(trialDirectory, "trajectory.json")).replace(/\\/g, "/");
  }
}

export async function finalizeScopeReadout(
  input: ScopeReporterManifest | string,
  options: ScopeFinalizeOptions,
): Promise<ScopeFinalizationResult> {
  await mkdir(options.outputDirectory, { recursive: true });
  const manifestPath = join(options.outputDirectory, MANIFEST_NAME);
  const manifest = typeof input === "string"
    ? JSON.parse(await readFile(input, "utf8")) as ScopeReporterManifest
    : structuredClone(input);
  try {
    assertCompleteManifest(manifest);
    const synthesisModel = options.judgeModel ?? "claude-opus-4.8";
    manifest.provenance.synthesis = {
      model: synthesisModel,
      policy: READOUT_SYNTHESIS_POLICY_VERSION,
    };
    const narrative = await generateReadoutNarrative(manifest, {
      model: synthesisModel,
      ...(options.targetProfileId ? { targetProfileId: options.targetProfileId } : {}),
    });
    const readout = buildReadout(manifest, {
      ...(options.targetProfileId ? { targetProfileId: options.targetProfileId } : {}),
      narrative,
    });
    await validateReadoutSchema(readout);
    const readoutPath = join(options.outputDirectory, READOUT_NAME);
    await writeJsonAtomic(readoutPath, readout);
    manifest.finalization = { status: "succeeded", readoutPath };
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
    return { status: "succeeded", readoutPath, manifestPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rm(join(options.outputDirectory, READOUT_NAME), { force: true });
    manifest.finalization = { status: "failed", error: message };
    manifest.updatedAt = new Date().toISOString();
    manifest.diagnostics.messages.push(message);
    await writeJsonAtomic(manifestPath, manifest);
    return { status: "failed", manifestPath, error: message };
  }
}

export async function finalizeScopeReadoutFromJsonl(
  jsonlPath: string,
  manifestPath: string,
  options: ScopeFinalizeOptions,
): Promise<ScopeFinalizationResult> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ScopeReporterManifest;
  const records = (await readFile(jsonlPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PersistedTrialRecord)
    .filter((record) => record.type === "trial-result");
  const profileById = new Map(manifest.profiles.map((profile) => [profile.id, profile]));
  const sidecarTrialByItemId = new Map(manifest.trials.map((trial) => [trial.itemId, trial]));
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  const trials: ScopeReporterTrial[] = [];
  for (const record of records) {
    if (seen.has(record.itemId)) {
      duplicates.add(record.itemId);
      continue;
    }
    seen.add(record.itemId);
    const profileId = createProfileId(
      record.evalFilePath,
      record.stimulus,
      record.variant,
      manifest.profiles.find((candidate) => candidate.name === record.variant)?.harness ?? "unknown",
      record.model ?? manifest.profiles.find((candidate) => candidate.name === record.variant)?.model ?? "unknown",
    );
    const profile = profileById.get(profileId);
    if (!profile) throw new Error(`Manifest has no profile metadata for persisted variant ${record.variant}`);
    trials.push(collectPersistedTrial(record, profile, sidecarTrialByItemId.get(record.itemId)));
  }
  manifest.trials = trials.sort((left, right) => left.itemId.localeCompare(right.itemId));
  manifest.diagnostics.duplicateItemIds = [...duplicates].sort();
  manifest.diagnostics.missingItemIds = manifest.expected.itemIds.filter((itemId) => !seen.has(itemId));
  manifest.expected.missingCount = Math.max(0, manifest.expected.totalItems - trials.length);
  if (manifest.status === "collecting" && manifest.expected.missingCount === 0 && duplicates.size === 0) {
    manifest.status = "completed";
  }
  return finalizeScopeReadout(manifest, options);
}

export function registerReporters(registry: ReporterRegistry): void {
  registry.register(new ScopeExperimentReporter(optionsFromEnvironment()));
  registry.register(new GradeResultReporter());
  registry.register(new AtifTrajectoryReporter());
}

function collectTrial(item: TrialWorkItem, result: TrialResult, baselineVariant?: string): ScopeReporterTrial {
  const scope = extractScope(result.grade);
  const model = item.model ?? result.trajectory?.metadata.model ?? "unknown";
  const harness = item.run.executor.name;
  const environment = toRecord(item.stimulus.environment);
  const profile = profileFromTrial(
    item.evalFilePath,
    item.stimulus.name,
    item.variant,
    model,
    harness,
    environment,
    baselineVariant,
  );
  const graderConfig = scopeGraderConfig(item);
  const criteria = criteriaFromItem(item);
  const trajectory = result.trajectory;
  return {
    itemId: item.id,
    runId: trajectory?.id ?? item.id,
    evalName: item.evalName,
    evalFilePath: item.evalFilePath,
    variant: item.variant,
    stimulusName: item.stimulus.name,
    instruction: item.stimulus.prompt,
    trialIndex: item.trialIndex ?? 0,
    totalTrials: item.totalTrials,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    durationMs: result.durationMs,
    profile,
    criteria,
    graderConfig,
    trajectoryMetadata: toRecord(trajectory?.metadata),
    ...(scope ? { scope: structuredClone(scope) } : {}),
    ...(scope ? { trajectoryRef: portableTrajectoryReference(scope, result.workspacePath) } : {}),
    artifactRefs: scope?.artifacts.map((reference) => portableArtifactReference(reference, result.workspacePath)) ?? [],
    usage: trajectoryUsage(trajectory),
    trajectoryEvents: structuredClone(trajectory?.events ?? []),
  };
}

interface PersistedTrialRecord {
  type: string;
  itemId: string;
  evalName: string;
  evalFilePath: string;
  variant: string;
  stimulus: string;
  model?: string;
  trialIndex?: number;
  totalTrials?: number;
  status: "success" | "error" | "skipped";
  durationMs: number;
  error?: string;
  skipReason?: string;
  workspacePath?: string;
  gradeResult: unknown;
  trajectory: any;
}

function collectPersistedTrial(
  record: PersistedTrialRecord,
  profile: ScopeReporterProfile,
  sidecarTrial?: ScopeReporterTrial,
): ScopeReporterTrial {
  const scope = extractScope(record.gradeResult);
  const manifestCriteria = scope?.criteria.map((criterion) => ({
    name: criterion.name,
    classification: criterion.classification,
  })) ?? [];
  return {
    itemId: record.itemId,
    runId: record.trajectory?.id ?? record.itemId,
    evalName: record.evalName,
    evalFilePath: record.evalFilePath,
    variant: record.variant,
    stimulusName: record.stimulus,
    instruction: record.trajectory?.stimulus?.prompt ?? "",
    trialIndex: record.trialIndex ?? 0,
    totalTrials: record.totalTrials ?? 1,
    status: record.status,
    ...(record.error ? { error: record.error } : {}),
    ...(record.skipReason ? { skipReason: record.skipReason } : {}),
    durationMs: record.durationMs,
    profile,
    criteria: manifestCriteria,
    graderConfig: structuredClone(sidecarTrial?.graderConfig ?? {}),
    trajectoryMetadata: {
      ...structuredClone(sidecarTrial?.trajectoryMetadata ?? {}),
      ...toRecord(record.trajectory?.metadata),
    },
    ...(scope ? { scope } : {}),
    ...(scope ? { trajectoryRef: portableTrajectoryReference(scope, record.workspacePath) } : {}),
    artifactRefs: scope?.artifacts.map((reference) => portableArtifactReference(reference, record.workspacePath)) ?? [],
    usage: trajectoryUsage(record.trajectory),
    trajectoryEvents: structuredClone(record.trajectory?.events ?? []),
  };
}

function criteriaFromItem(item: TrialWorkItem): ScopeReporterCriterion[] {
  const config = scopeGraderConfig(item);
  if (!config || !Array.isArray(config.criteria)) return [];
  return config.criteria.flatMap((criterion) => {
    if (!criterion || typeof criterion !== "object") return [];
    const value = criterion as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.classification !== "string") return [];
    return [{
      name: value.name,
      classification: value.classification,
      ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    }];
  });
}

function scopeGraderConfig(item: TrialWorkItem): Record<string, unknown> {
  return toRecord(item.run.graderConfigs.find((grader) => grader.type === "scope")?.config);
}

function extractScope(grade: unknown): ScopeResult | undefined {
  if (!grade || typeof grade !== "object") return undefined;
  const value = grade as Record<string, any>;
  const candidates = [value, ...(Array.isArray(value.details) ? value.details : [])];
  for (const candidate of candidates) {
    const scope = candidate?.metadata?.scope;
    if (scope?.schemaVersion === "2.0") return scope as ScopeResult;
  }
  return undefined;
}

function profileFromTrial(
  evalFilePath: string,
  stimulusName: string,
  variant: string,
  model: string,
  harness: string,
  environment: Record<string, unknown>,
  baselineVariant?: string,
): ScopeReporterProfile {
  const extensions = [
    ...stringArray(environment.skills),
    ...Object.keys(toRecord(environment.mcpServers)).map((name) => `mcp:${name}`),
  ].sort();
  return {
    id: createProfileId(evalFilePath, stimulusName, variant, harness, model),
    name: variant,
    harness,
    model,
    extensions,
    isBaseline: baselineVariant ? variant === baselineVariant : false,
    environment,
  };
}

function createProfileId(
  evalFilePath: string,
  stimulusName: string,
  variant: string,
  harness: string,
  model: string,
): string {
  return [evalFilePath, stimulusName, variant, harness, model].map(encodeURIComponent).join("--");
}

function trajectoryUsage(trajectory: any): ScopeReporterTrial["usage"] {
  const usage = trajectory?.metrics?.tokenUsage;
  return {
    inputTokens: finiteNumber(usage?.inputTokens),
    outputTokens: finiteNumber(usage?.outputTokens),
    cacheReadTokens: finiteNumber(usage?.cacheReadTokens),
    cacheWriteTokens: finiteNumber(usage?.cacheWriteTokens),
    requests: finiteNumber(usage?.callCount),
  };
}

function portableTrajectoryReference(scope: ScopeResult, workspacePath?: string): string {
  const reference = scope.artifacts.find((artifact) => artifact.kind === "trajectory" && artifact.path)?.path;
  if (!reference) return scope.trajectoryId;
  return portablePath(reference, workspacePath);
}

function portableArtifactReference(reference: ScopeResult["artifacts"][number], workspacePath?: string) {
  return {
    ...reference,
    ...(reference.path ? { path: portablePath(reference.path, workspacePath) } : {}),
  };
}

function portablePath(path: string, workspacePath?: string): string {
  if (!isAbsolute(path)) return path;
  if (workspacePath) {
    const relativePath = relative(workspacePath, path);
    if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
  }
  return `artifact:${path}`;
}

function optionsFromEnvironment(): ScopeReporterOptions {
  return {
    ...(process.env.SCOPE_READOUT_OUTPUT ? { outputDirectory: resolve(process.env.SCOPE_READOUT_OUTPUT) } : {}),
    ...(process.env.SCOPE_TARGET_PROFILE ? { targetProfileId: process.env.SCOPE_TARGET_PROFILE } : {}),
    ...(process.env.SCOPE_BASELINE_VARIANT ? { baselineVariant: process.env.SCOPE_BASELINE_VARIANT } : {}),
    ...(process.env.SCOPE_READOUT_MODEL ? { judgeModel: process.env.SCOPE_READOUT_MODEL } : {}),
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const pending = `${path}.pending`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, path);
}

function uniqueProfiles(trials: ScopeReporterTrial[]): ScopeReporterProfile[] {
  const profiles = new Map<string, ScopeReporterProfile>();
  for (const trial of trials) {
    const existing = profiles.get(trial.profile.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(trial.profile)) {
      throw new Error(`Variant ${trial.profile.id} resolved to incompatible profile metadata`);
    }
    profiles.set(trial.profile.id, trial.profile);
  }
  return [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
