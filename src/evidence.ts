import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Trajectory } from "@microsoft/vally";
import type { ScopeEvidenceReference, ScopeUsageEvidence } from "./contract.js";

type TrajectorySnapshot = Pick<
  Trajectory,
  "id" | "stimulus" | "events" | "metrics" | "output" | "metadata"
> & Pick<Partial<Trajectory>, "endReason">;

export interface PreservedTrajectoryEvidence {
  trajectory: Readonly<TrajectorySnapshot>;
  patch?: string;
  references: ScopeEvidenceReference[];
  usage: ScopeUsageEvidence;
}

export class ScopeEvidenceError extends Error {}

export async function preserveTrajectory(
  trajectory: Trajectory,
  evidenceRoot: string,
  diffBaseDir?: string,
): Promise<PreservedTrajectoryEvidence> {
  const snapshot: TrajectorySnapshot = deepFreeze(structuredClone({
    id: trajectory.id,
    stimulus: trajectory.stimulus,
    events: trajectory.events,
    metrics: trajectory.metrics,
    output: trajectory.output,
    metadata: trajectory.metadata,
    ...(trajectory.endReason ? { endReason: trajectory.endReason } : {}),
  }));
  const evidenceDirectory = join(evidenceRoot, "scope", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const trajectoryPath = join(evidenceDirectory, "trajectory.json");
  await writeFile(trajectoryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const references: ScopeEvidenceReference[] = [{
    kind: "trajectory",
    path: trajectoryPath,
    trajectoryId: trajectory.id,
    description: "Normalized Vally trajectory",
  }];
  const patch = await resolvePatch(trajectory, diffBaseDir);
  if (patch !== undefined) {
    const patchPath = join(evidenceDirectory, "workspace.patch");
    await writeFile(patchPath, patch, "utf8");
    references.push({
      kind: "diff",
      path: patchPath,
      trajectoryId: trajectory.id,
      description: "Vally-captured workspace diff",
    });
  }

  return {
    trajectory: snapshot,
    ...(patch !== undefined ? { patch } : {}),
    references,
    usage: extractUsage(trajectory),
  };
}

async function resolvePatch(trajectory: Trajectory, diffBaseDir?: string): Promise<string | undefined> {
  if (typeof trajectory.workspacePatch === "string") return trajectory.workspacePatch;
  if (typeof trajectory.diff === "string") return trajectory.diff;
  if (trajectory.workspacePatchCaptureError) {
    throw new ScopeEvidenceError(
      `Vally could not capture the workspace diff: ${trajectory.workspacePatchCaptureError}`,
    );
  }
  if (!trajectory.diffPath) return undefined;
  const path = isAbsolute(trajectory.diffPath)
    ? trajectory.diffPath
    : resolve(diffBaseDir ?? trajectory.workDir, trajectory.diffPath);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ScopeEvidenceError(
      `Vally diff sidecar is missing or unreadable: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function extractUsage(trajectory: Trajectory): ScopeUsageEvidence {
  const tokens = trajectory.metrics.tokenUsage;
  return {
    requests: tokens.callCount,
    promptTokens: tokens.inputTokens,
    completionTokens: tokens.outputTokens,
    cachedTokens: tokens.cacheReadTokens + tokens.cacheWriteTokens,
    ...(tokens.cost ? { cost: tokens.cost } : {}),
    trajectories: [{
      trajectoryId: trajectory.id,
      eventIndexes: trajectory.events.map((_, index) => index),
    }],
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}