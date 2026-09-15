import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtifTrajectoryReporter } from "../src/atif-reporter.js";

const testRoot = join(process.cwd(), ".test-work", "atif-reporter");

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("AtifTrajectoryReporter", () => {
  it("writes root and subagent ATIF trajectories after a trial", async () => {
    const reporter = new AtifTrajectoryReporter();
    const itemId = "eval.yaml::learn::claude-sonnet-5::create-file::trial-0";
    const trialDirectory = join(testRoot, "learn", "scope-fixture", "create-file", "claude-sonnet-5", "0");
    await mkdir(trialDirectory, { recursive: true });
    await writeFile(join(trialDirectory, "metadata.json"), JSON.stringify({ trialId: itemId }), "utf8");
    const item = {
      id: itemId,
      evalName: "scope-fixture",
      evalFilePath: "tests/fixtures/scope-grader/eval.yaml",
      variant: "learn",
      model: "claude-sonnet-5",
      stimulus: { name: "create-file", prompt: "Create answer.txt" },
      trialIndex: 0,
      totalTrials: 1,
    } as never;
    const result = {
      itemId,
      durationMs: 1_000,
      status: "success",
      trajectory: {
        id: "trajectory-1",
        stimulus: { name: "create-file", prompt: "Create answer.txt" },
        events: [
          { type: "user_message", turn: 0, data: { content: "Create answer.txt" } },
          {
            type: "tool_call",
            turn: 0,
            data: {
              toolName: "task",
              toolCallId: "call-1",
              arguments: { prompt: "Create the file" },
              launchedAgentIds: ["worker-1"],
            },
          },
          {
            type: "assistant_message",
            turn: 0,
            agentId: "worker-1",
            data: { content: "Created answer.txt" },
          },
          {
            type: "tool_result",
            turn: 0,
            data: { toolName: "task", toolCallId: "call-1", success: true, result: "Done" },
          },
        ],
        metrics: {
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            callCount: 1,
            byModel: { "claude-sonnet-5": { inputTokens: 100, outputTokens: 20, callCount: 1 } },
          },
          toolCallCount: 1,
          toolCallBreakdown: { task: 1 },
          simulatedToolCallCount: 0,
          skillActivationCount: 0,
          skillActivationBreakdown: {},
          turnCount: 1,
          wallTimeMs: 1_000,
          errorCount: 0,
        },
        output: "Created answer.txt",
        workDir: "/workspace",
        metadata: {
          model: "claude-sonnet-5",
          skillsLoaded: [],
          executor: "copilot-sdk",
          sessionID: "session-1",
        },
      },
    } as never;

    await reporter.onTrialResult({ item, result });
    await reporter.onRunComplete({} as never, { sessionLogsDir: testRoot });

    const root = JSON.parse(await readFile(join(trialDirectory, "trajectory.json"), "utf8"));
    const subagent = JSON.parse(
      await readFile(join(trialDirectory, "trajectory.worker-1.json"), "utf8"),
    );

    expect(root).toMatchObject({
      schema_version: "ATIF-v1.8",
      session_id: "session-1",
      trajectory_id: "trajectory-1",
    });
    expect(root.steps.some((step: any) => step.tool_calls?.[0]?.function_name === "task")).toBe(true);
    expect(subagent).toMatchObject({
      schema_version: "ATIF-v1.8",
      session_id: "session-1:worker-1",
      trajectory_id: "worker-1",
    });
  });

  it("does not write an artifact when no trajectory is available", async () => {
    const reporter = new AtifTrajectoryReporter();

    await reporter.onTrialResult({
      item: { id: "failed-trial" } as never,
      result: { status: "error", trajectory: null } as never,
    });
    await reporter.onRunComplete({} as never, { sessionLogsDir: testRoot });

    await expect(readFile(join(testRoot, "trajectory.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});