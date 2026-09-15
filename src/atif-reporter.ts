import { join } from "node:path";
import type { PlanReporter, RunArtifacts, RunSummary, TrialResult, TrialWorkItem } from "@microsoft/vally";
import { convert, type Trajectory as AtifTrajectory } from "atifact";
import { findFinalTrialDirectories, writeJsonAtomic } from "./trial-output.js";

interface PendingAtifTrajectories {
  itemId: string;
  root: AtifTrajectory;
  subagents: Map<string, AtifTrajectory>;
}

export class AtifTrajectoryReporter implements PlanReporter {
  private readonly pending = new Map<string, PendingAtifTrajectories>();

  async onTrialResult(event: { item: TrialWorkItem; result: TrialResult }): Promise<void> {
    if (!event.result.trajectory) return;

    const converted = await convert(JSON.stringify(event.result.trajectory), {
      format: "vally-json",
      sourceName: event.item.id,
    });
    this.pending.set(event.item.id, {
      itemId: event.item.id,
      root: converted.trajectory,
      subagents: converted.subagentTrajectories ?? new Map(),
    });
  }

  async onRunComplete(_summary: RunSummary, artifacts: RunArtifacts): Promise<void> {
    if (!artifacts.sessionLogsDir || this.pending.size === 0) return;

    const directories = await findFinalTrialDirectories(artifacts.sessionLogsDir);
    for (const { itemId, root, subagents } of this.pending.values()) {
      const outputDirectory = directories.get(itemId);
      if (!outputDirectory) continue;
      await writeJsonAtomic(join(outputDirectory, "trajectory.json"), root);
      for (const [agentId, trajectory] of subagents) {
        await writeJsonAtomic(
          join(outputDirectory, `trajectory.${safeSegment(agentId)}.json`),
          trajectory,
        );
      }
    }
  }
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "unnamed";
}
