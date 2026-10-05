import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@github/copilot-sdk", () => ({
  approveAll: vi.fn(),
  defineTool: (name: string, config: Record<string, unknown>) => ({ name, ...config }),
}));

import type { ScopeGraderConfig } from "../src/config.js";
import type { ScopeJudgeSession } from "../src/judge-client.js";
import { analyzeBehavior, evaluateCriterion, evaluateGate } from "../src/judging.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("criterion judge isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a fresh session and workspace without prior verdicts for every criterion", async () => {
    const sessionConfigs: Array<Record<string, any>> = [];
    const prompts: string[] = [];
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => {
        sessionConfigs.push(sessionConfig);
        return {
          sendAndWait: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt);
            const tool = sessionConfig.tools[0];
            await tool.handler({ result: "pass", reason: `secret-${prompts.length}`, evidence: [] });
            return { data: { content: "" } };
          },
          disconnect: vi.fn(),
        } satisfies ScopeJudgeSession;
      }),
    };
    const workspaceFactory = {
      create: vi.fn(async (label: string) => `/isolated/${label}`),
    };
    const criteria: ScopeGraderConfig["criteria"] = [
      { name: "one", classification: "prerequisite", instructions: "first" },
      { name: "two", classification: "idiomaticUse", instructions: "second" },
    ];

    await evaluateCriterion(client as never, workspaceFactory as never, criteria[0]!, "judge", 0, "task");
    await evaluateCriterion(client as never, workspaceFactory as never, criteria[1]!, "judge", 1, "task", "shared rules");

    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(sessionConfigs[0]?.workingDirectory).not.toBe(sessionConfigs[1]?.workingDirectory);
    expect(prompts[1]).not.toContain("secret-1");
    expect(prompts[0]).not.toContain("Instructions for every criterion");
    expect(prompts[1]).toContain("Instructions for every criterion:\nshared rules\n\nCriterion: two\nInstructions: second");
    expect(sessionConfigs[0]?.tools).not.toBe(sessionConfigs[1]?.tools);
  });

  it("rejects malformed verdict arguments so the judge can resubmit in the same session", async () => {
    const responses: unknown[] = [];
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async () => {
          const tool = sessionConfig.tools[0];
          responses.push(await tool.handler({ result: "pass", reason: "ok", evidence: "[]" }));
          responses.push(await tool.handler({ result: "pass", reason: "ok", evidence: [] }));
          return { data: { content: "" } };
        },
        disconnect: vi.fn(),
      }) satisfies ScopeJudgeSession),
    };
    const workspaceFactory = { create: vi.fn(async (label: string) => `/isolated/${label}`) };

    const result = await evaluateCriterion(
      client as never,
      workspaceFactory as never,
      { name: "one", classification: "idiomaticUse", instructions: "verify" },
      "judge",
      0,
      "task",
    );

    expect(responses[0]).toMatchObject({ ok: false });
    expect(responses[1]).toEqual({ ok: true });
    expect(result.state).toBe("passed");
    expect(client.createSession).toHaveBeenCalledOnce();
  });

  it("retries a missing verdict up to three times in fresh sessions and workspaces", async () => {
    let attempt = 0;
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async () => {
          attempt++;
          if (attempt === 3) {
            await sessionConfig.tools[0].handler({ result: "pass", reason: "verified", evidence: [] });
          }
        },
        disconnect: vi.fn(),
      })),
    };
    const workspaceFactory = { create: vi.fn(async (label: string) => `/isolated/${label}`) };
    const criterion: ScopeGraderConfig["criteria"][number] = {
      name: "retriable",
      classification: "prerequisite",
      instructions: "verify",
    };

    const result = await evaluateCriterion(
      client as never,
      workspaceFactory as never,
      criterion,
      "judge",
      0,
      "task",
    );

    expect(result.state).toBe("passed");
    expect(client.createSession).toHaveBeenCalledTimes(3);
    expect(workspaceFactory.create).toHaveBeenCalledTimes(3);
    expect(new Set(workspaceFactory.create.mock.calls.map(([label]) => label)).size).toBe(3);
  });

  it("fails after three unsuccessful criterion attempts", async () => {
    const client = {
      createSession: vi.fn(async () => ({ sendAndWait: vi.fn(), disconnect: vi.fn() })),
    };
    const criterion: ScopeGraderConfig["criteria"][number] = {
      name: "unavailable",
      classification: "prerequisite",
      instructions: "verify",
    };

    await expect(evaluateCriterion(
      client as never,
      { create: vi.fn(async (label: string) => `/isolated/${label}`) } as never,
      criterion,
      "judge",
      0,
      "task",
    )).rejects.toThrow("after 3 attempts");
    expect(client.createSession).toHaveBeenCalledTimes(3);
  });
});

describe("prompted Run gate", () => {
  it("applies explicit success criteria through a structured workspace judge", async () => {
    const disconnect = vi.fn();
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async () => {
          await sessionConfig.tools[0].handler({
            result: "inapplicable",
            reason: "No safe offline path exists",
            evidence: ["The entry point requires live credentials before startup"],
            defects: {
              rawCount: 1,
              rootCauses: [{ category: "AUTH", count: 1, description: "Credentials are required" }],
            },
          });
        },
        disconnect,
      })),
    };

    const result = await evaluateGate(
      client as never,
      { create: vi.fn().mockResolvedValue("/isolated/run") } as never,
      "run",
      "Use an offline path; otherwise report inapplicable.",
      "judge",
    );

    expect(result).toMatchObject({
      state: "inapplicable",
      reason: "No safe offline path exists",
      prompt: "Use an offline path; otherwise report inapplicable.",
      defects: { rawCount: 1 },
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: "/isolated/run",
      model: "judge",
    }));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("reuses a persistent execution workspace created before Build", async () => {
    const workspaceFactory = { create: vi.fn() };
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async ({ prompt }: { prompt: string }) => {
          expect(prompt).toContain("Changes made by earlier execution gates persist");
          await sessionConfig.tools[0].handler({
            result: "pass",
            reason: "Used the dependencies restored during Build",
            evidence: ["The persisted virtual environment provided the imported package"],
            defects: { rawCount: 0, rootCauses: [] },
          });
        },
        disconnect: vi.fn(),
      })),
    };

    const result = await evaluateGate(
      client as never,
      workspaceFactory as never,
      "run",
      "Run the offline entry point.",
      "judge",
      "/isolated/execution-gates",
    );

    expect(result.state).toBe("passed");
    expect(workspaceFactory.create).not.toHaveBeenCalled();
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: "/isolated/execution-gates",
    }));
  });
});

describe("prompted Build gate", () => {
  it("restores packages and compiles through a structured workspace judge", async () => {
    const disconnect = vi.fn();
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async ({ prompt }: { prompt: string }) => {
          expect(prompt).toContain("Build success criteria");
          expect(prompt).toContain("submit_build_gate");
          await sessionConfig.tools[0].handler({
            result: "pass",
            reason: "Package restoration and compilation succeeded",
            evidence: ["pip install and compileall exited with code 0"],
            defects: { rawCount: 0, rootCauses: [] },
          });
        },
        disconnect,
      })),
    };

    const result = await evaluateGate(
      client as never,
      { create: vi.fn().mockResolvedValue("/isolated/build") } as never,
      "build",
      "Restore packages, then compile all Python files.",
      "judge",
    );

    expect(result).toMatchObject({
      name: "build",
      state: "passed",
      reason: "Package restoration and compilation succeeded",
      prompt: "Restore packages, then compile all Python files.",
      defects: { rawCount: 0 },
    });
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: "/isolated/build",
      model: "judge",
    }));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("behavior evidence identities", () => {
  it("accepts evidence tied to a normalized Vally event", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    const workspace = join(root, "workspace");
    const source = join(root, "trajectory.json");
    roots.push(root);
    await mkdir(workspace, { recursive: true });
    await writeFile(source, "{}\n");

    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async () => {
          await sessionConfig.tools[0].handler({
            behaviorObservations: [{
              behavior: "CorrectOutcome",
              category: "Execution",
              extensionPointSurface: "BaseModelKnowledge",
              sourceArtifact: "trajectory.json",
              evidence: "The final response reports completion.",
              trajectoryId: "live-session",
              eventIndex: 0,
            }],
            rootCauses: [],
          });
        },
        disconnect: vi.fn(),
      })),
    };
    const evidence = {
      trajectory: { id: "live-session", events: [{ type: "assistant_message" }] },
      references: [{ kind: "trajectory", path: source }],
    };

    const result = await analyzeBehavior(
      client as never,
      { create: vi.fn().mockResolvedValue(workspace) } as never,
      evidence as never,
      "judge",
      {},
    );

    expect(result.behaviorObservations[0]).toMatchObject({
      trajectoryId: "live-session",
      eventIndex: 0,
    });
  });

  it("rejects a correct execution label when deterministic verification failed", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    const workspace = join(root, "workspace");
    const source = join(root, "trajectory.json");
    roots.push(root);
    await mkdir(workspace, { recursive: true });
    await writeFile(source, "{}\n");
    const prompts: string[] = [];
    const client = {
      createSession: vi.fn(async (sessionConfig: Record<string, any>) => ({
        sendAndWait: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          await sessionConfig.tools[0].handler({
            behaviorObservations: [{
              behavior: "CorrectOutcome",
              category: "Execution",
              extensionPointSurface: "BaseModelKnowledge",
              sourceArtifact: "trajectory.json",
              evidence: "Claimed success despite the failed build.",
              trajectoryId: "failed-session",
              eventIndex: 0,
            }],
            rootCauses: [],
          });
        },
        disconnect: vi.fn(),
      })),
    };

    await expect(analyzeBehavior(
      client as never,
      { create: vi.fn().mockResolvedValue(workspace) } as never,
      {
        trajectory: { id: "failed-session", events: [{ type: "assistant_message" }] },
        references: [{ kind: "trajectory", path: source }],
      } as never,
      "judge",
      {
        gates: { build: { state: "failed" } },
        criteria: [{ name: "Select", state: "passed" }],
      },
    )).rejects.toThrow("no valid Execution observation");
    expect(prompts[0]).toContain("CorrectOutcome and CorrectButInefficient are invalid");
    expect(prompts[0]).toContain("Failed gates: build");
  });
});