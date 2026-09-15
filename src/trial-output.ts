import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface TrialDirectory {
  path: string;
  attemptIndex: number;
}

export async function findFinalTrialDirectories(root: string): Promise<Map<string, string>> {
  const directories = new Map<string, TrialDirectory[]>();
  await visit(root);

  return new Map([...directories].map(([itemId, matches]) => [
    itemId,
    [...matches].sort(
      (left, right) => right.attemptIndex - left.attemptIndex || right.path.localeCompare(left.path),
    )[0]!.path,
  ]));

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === "metadata.json") {
        const metadata = await readMetadata(path);
        if (!metadata?.trialId) continue;
        const matches = directories.get(metadata.trialId) ?? [];
        matches.push({ path: directory, attemptIndex: metadata.attemptIndex ?? 0 });
        directories.set(metadata.trialId, matches);
      }
    }
  }
}

async function readMetadata(
  path: string,
): Promise<{ trialId?: string; attemptIndex?: number } | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as {
      trialId?: string;
      attemptIndex?: number;
    };
  } catch {
    return undefined;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const pending = `${path}.pending`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, path);
}