import { join } from "node:path";
import type {
  PlanReporter,
  RunArtifacts,
  RunSummary,
  TrialResult,
  TrialWorkItem,
} from "@microsoft/vally";
import { findFinalTrialDirectories, writeJsonAtomic } from "./trial-output.js";

interface PendingGradeResult {
  itemId: string;
  grade: NonNullable<TrialResult["grade"]>;
}

export class GradeResultReporter implements PlanReporter {
  private readonly pending = new Map<string, PendingGradeResult>();

  async onTrialResult(event: { item: TrialWorkItem; result: TrialResult }): Promise<void> {
    if (!event.result.grade) return;
    this.pending.set(event.item.id, {
      itemId: event.item.id,
      grade: structuredClone(event.result.grade),
    });
  }

  async onRunComplete(_summary: RunSummary, artifacts: RunArtifacts): Promise<void> {
    if (!artifacts.sessionLogsDir || this.pending.size === 0) return;

    const directories = await findFinalTrialDirectories(artifacts.sessionLogsDir);
    for (const { itemId, grade } of this.pending.values()) {
      const directory = directories.get(itemId);
      if (directory) {
        await writeJsonAtomic(join(directory, "grade-result.json"), grade);
      }
    }
  }
}