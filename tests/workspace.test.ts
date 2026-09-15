import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IsolatedWorkspaceFactory } from "../src/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("IsolatedWorkspaceFactory", () => {
  it("creates independent criterion workspaces from one immutable snapshot", async () => {
    const root = join(process.cwd(), ".test-work", crypto.randomUUID());
    roots.push(root);
    const source = join(root, "source");
    const artifacts = join(root, "artifacts");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "answer.txt"), "original");
    const factory = new IsolatedWorkspaceFactory(source, artifacts);
    await factory.initialize();

    const first = await factory.create("criterion-one");
    await writeFile(join(first, "answer.txt"), "verdict leak");
    const second = await factory.create("criterion-two");

    expect(first).not.toBe(second);
    expect(await readFile(join(second, "answer.txt"), "utf8")).toBe("original");
  });
});