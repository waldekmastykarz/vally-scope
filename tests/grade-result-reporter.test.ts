import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReporterRegistry } from "@microsoft/vally";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtifTrajectoryReporter } from "../src/atif-reporter.js";
import { GradeResultReporter } from "../src/grade-result-reporter.js";
import { registerReporters } from "../src/reporter.js";

const testRoot = join(process.cwd(), ".test-work", "grade-result-reporter");

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("GradeResultReporter", () => {
  it("registers both sidecar reporters without configuration", () => {
    const registry = createReporterRegistry();

    registerReporters(registry);

    expect(registry.getAll().filter((reporter) => reporter instanceof GradeResultReporter)).toHaveLength(1);
    expect(registry.getAll().filter((reporter) => reporter instanceof AtifTrajectoryReporter)).toHaveLength(1);
  });

  it("writes the complete grade result to the final trial attempt directory", async () => {
    const reporter = new GradeResultReporter();
    const itemId = "eval.yaml::learn::claude-sonnet-5::create-file::trial-0";
    const firstAttempt = join(testRoot, "learn", "eval", "stimulus", "model", "0");
    const finalAttempt = join(testRoot, "learn", "eval", "stimulus", "model", "0__attempt-1");
    await writeTrialMetadata(firstAttempt, itemId, 0);
    await writeTrialMetadata(finalAttempt, itemId, 1);

    const grade = {
      name: "trajectory-grade",
      passed: true,
      score: 1,
      evidence: "1/1 graders passed",
      details: [{
        name: "scope/criterion/Creates file",
        passed: true,
        score: 1,
        evidence: "The agent created the requested file.",
        metadata: { scopeCriterion: { classification: "efficacy" } },
      }],
    };
    await reporter.onTrialResult({
      item: { id: itemId } as never,
      result: { status: "success", grade } as never,
    });
    await reporter.onRunComplete({} as never, { sessionLogsDir: testRoot });

    expect(JSON.parse(await readFile(join(finalAttempt, "grade-result.json"), "utf8"))).toEqual(grade);
    await expect(readFile(join(firstAttempt, "grade-result.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not write an artifact when a trial has no grade result", async () => {
    const reporter = new GradeResultReporter();
    const trialDirectory = join(testRoot, "eval", "stimulus", "model", "0");
    await writeTrialMetadata(trialDirectory, "failed-trial", 0);

    await reporter.onTrialResult({
      item: { id: "failed-trial" } as never,
      result: { status: "error" } as never,
    });
    await reporter.onRunComplete({} as never, { sessionLogsDir: testRoot });

    await expect(readFile(join(trialDirectory, "grade-result.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function writeTrialMetadata(
  directory: string,
  trialId: string,
  attemptIndex: number,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify({ trialId, attemptIndex }),
    "utf8",
  );
}