import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preserveTrajectory } from "../src/evidence.js";

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = join(process.cwd(), ".test-work", crypto.randomUUID());
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function trajectory(root: string) {
  return {
    id: "live-session",
    stimulus: { name: "fixture", prompt: "Create answer.txt" },
    events: [
      { type: "user_message", data: { content: "Create answer.txt" } },
      { type: "assistant_message", data: { content: "Created answer.txt" } },
    ],
    metrics: {
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        callCount: 1,
        cost: { provider: "github-copilot", unit: "nano-aiu", amount: 25 },
        byModel: { judge: { inputTokens: 10, outputTokens: 4, callCount: 1 } },
      },
      toolCallCount: 0,
      toolCallBreakdown: {},
      simulatedToolCallCount: 0,
      skillActivationCount: 0,
      skillActivationBreakdown: {},
      turnCount: 1,
      wallTimeMs: 100,
      errorCount: 0,
    },
    output: "Created answer.txt",
    workDir: root,
    artifactDir: join(root, "artifacts"),
    metadata: { model: "judge", skillsLoaded: [], executor: "copilot-sdk", sessionID: "live-session" },
  };
}

describe("preserveTrajectory", () => {
  it("preserves a normalized live trajectory without raw ATIF", async () => {
    const root = await fixtureRoot();
    const result = await preserveTrajectory(trajectory(root) as never, join(root, "scope-output"));

    expect(result.trajectory).not.toHaveProperty("raw");
    expect(result.trajectory.events).toHaveLength(2);
    expect(Object.isFrozen(result.trajectory)).toBe(true);
    expect(result.references[0]).toMatchObject({
      kind: "trajectory",
      trajectoryId: "live-session",
    });
    const snapshot = JSON.parse(await readFile(result.references[0]!.path!, "utf8"));
    expect(snapshot.events).toHaveLength(2);
    expect(result.usage).toMatchObject({
      requests: 1,
      promptTokens: 10,
      completionTokens: 4,
      cachedTokens: 3,
      cost: { provider: "github-copilot", unit: "nano-aiu", amount: 25 },
      trajectories: [{ trajectoryId: "live-session", eventIndexes: [0, 1] }],
    });
  });

  it("ignores producer-specific raw input", async () => {
    const root = await fixtureRoot();
    const result = await preserveTrajectory(
      { ...trajectory(root), raw: { arbitrary: true } } as never,
      join(root, "scope-output"),
    );

    expect(result.trajectory).not.toHaveProperty("raw");
  });

  it("supports live trajectories without an artifact directory", async () => {
    const root = await fixtureRoot();
    const { artifactDir: _artifactDir, ...withoutArtifacts } = trajectory(root);
    await expect(
      preserveTrajectory(withoutArtifacts as never, join(root, "scope-output")),
    ).resolves.toMatchObject({
      trajectory: { id: "live-session" },
    });
  });

  it("preserves Vally's inline workspace patch", async () => {
    const root = await fixtureRoot();
    const patch = "diff --git a/a.py b/a.py\n+print('ready')\n";
    const result = await preserveTrajectory(
      { ...trajectory(root), workspacePatch: patch } as never,
      join(root, "scope-output"),
    );

    const reference = result.references.find((item) => item.kind === "diff");
    expect(result.patch).toBe(patch);
    expect(await readFile(reference!.path!, "utf8")).toBe(patch);
  });

  it("preserves a Vally diff sidecar", async () => {
    const root = await fixtureRoot();
    const patch = "diff --git a/a.py b/a.py\n+print('ready')\n";
    await writeFile(join(root, "captured.patch"), patch);
    const result = await preserveTrajectory(
      { ...trajectory(root), diffPath: "captured.patch" } as never,
      join(root, "scope-output"),
      root,
    );

    expect(result.patch).toBe(patch);
    expect(result.references.some((item) => item.kind === "diff")).toBe(true);
  });

  it("surfaces Vally workspace patch capture failures", async () => {
    const root = await fixtureRoot();
    await expect(
      preserveTrajectory(
        { ...trajectory(root), workspacePatchCaptureError: "git diff failed" } as never,
        join(root, "scope-output"),
      ),
    ).rejects.toThrow("Vally could not capture the workspace diff: git diff failed");
  });
});