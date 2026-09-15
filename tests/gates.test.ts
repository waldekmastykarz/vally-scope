import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScopeGateResult } from "../src/contract.js";
import {
  blockedGate,
  detectBuildCommand,
  detectStartCommand,
  detectTestCommand,
  executeGate,
  extractDefects,
  findProjectRoot,
  initialGates,
  shouldExecuteRun,
  shouldExecuteTest,
} from "../src/gates.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const gate = (name: ScopeGateResult["name"], state: ScopeGateResult["state"]): ScopeGateResult => ({
  name,
  state,
  reason: state,
  evidence: [],
});

describe("Scope gate state machine", () => {
  it("marks execution gates inapplicable for response scenarios", () => {
    const gates = initialGates("response");
    expect([gates.build.state, gates.test.state, gates.run.state]).toEqual([
      "inapplicable",
      "inapplicable",
      "inapplicable",
    ]);
  });

  it.each(["failed", "inapplicable", "error"] as const)(
    "blocks Test when Build is %s",
    (state) => {
      expect(shouldExecuteTest(gate("build", state))).toBe(false);
      expect(blockedGate("test", "build", state).state).toBe("failed");
    },
  );

  it("runs Test only after Build passes", () => {
    expect(shouldExecuteTest(gate("build", "passed"))).toBe(true);
  });

  it.each(["passed", "inapplicable"] as const)(
    "runs Run after Build passes and Test is %s",
    (state) => {
      expect(shouldExecuteRun(gate("build", "passed"), gate("test", state))).toBe(true);
    },
  );

  it.each(["failed", "prerequisite-blocked", "error"] as const)(
    "blocks Run when Test is %s",
    (state) => {
      expect(shouldExecuteRun(gate("build", "passed"), gate("test", state))).toBe(false);
    },
  );
});

describe("deterministic gate execution", () => {
  it("counts and groups compiler and runtime diagnostics", () => {
    expect(extractDefects(
      "src/a.ts(1,1): error TS2322: Type mismatch\nsrc/b.ts(2,1): error TS2322: Type mismatch",
      "TypeError: Cannot read properties of undefined",
    )).toEqual({
      rawCount: 3,
      rootCauses: [{ category: "TS2322", count: 2, description: "Type mismatch" }, {
        category: "TYPEERROR",
        count: 1,
        description: "Cannot read properties of undefined",
      }],
    });
  });

  it("detects an npm project and its configured commands", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    const project = join(root, "nested", "project");
    roots.push(root);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({
      scripts: { build: "node build.js", test: "node test.js", start: "node index.js" },
    }));

    expect(findProjectRoot(root)).toBe(project);
    expect(detectBuildCommand(project)).toBe("npm run build");
    expect(detectTestCommand(project)).toBe("npm test");
    expect(detectStartCommand(project)).toBe("npm start");
  });

  it("executes a detected build command without a judge session", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { build: "node -e \"process.stdout.write('built')\"" },
    }));

    const result = await executeGate(root, "build");

    expect(result.state).toBe("passed");
    expect(result.reason).toContain("npm run build");
    expect(result.evidence[0]?.description).toContain("built");
  });

  it("compiles a standalone Python script for Build", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "main.py"), "print('hello')\n");

    expect(detectBuildCommand(root)).toBe("python3 -m compileall .");
    await expect(executeGate(root, "build")).resolves.toMatchObject({ state: "passed" });
  });

  it("fails Build when no build command can be determined", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    roots.push(root);
    await mkdir(root, { recursive: true });

    await expect(executeGate(root, "build")).resolves.toMatchObject({
      state: "failed",
      reason: "Could not determine build command",
    });
  });

  it("marks Test inapplicable when the project has no tests", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "node build.js" } }));

    await expect(executeGate(root, "test")).resolves.toMatchObject({
      state: "inapplicable",
      reason: "No tests detected",
    });
  });
});
