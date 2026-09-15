import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export class IsolatedWorkspaceFactory {
  private readonly snapshotDirectory: string;
  private readonly judgeDirectory: string;

  constructor(
    private readonly sourceDirectory: string,
    artifactDirectory: string,
  ) {
    this.snapshotDirectory = join(artifactDirectory, "scope", "workspace-snapshot");
    this.judgeDirectory = join(artifactDirectory, "scope", "judge-workspaces");
  }

  async initialize(): Promise<void> {
    await rm(this.snapshotDirectory, { recursive: true, force: true });
    await mkdir(this.snapshotDirectory, { recursive: true });
    const excluded = this.isWithinSource(this.snapshotDirectory)
      ? relative(this.sourceDirectory, resolve(this.snapshotDirectory)).split("/")[0]
      : undefined;
    await cp(this.sourceDirectory, this.snapshotDirectory, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => {
        if (!excluded) return true;
        const relativeSource = relative(this.sourceDirectory, source);
        return relativeSource !== excluded && !relativeSource.startsWith(`${excluded}/`);
      },
    });
  }

  async create(label: string): Promise<string> {
    const destination = join(this.judgeDirectory, safeName(label));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(this.snapshotDirectory, destination, { recursive: true, verbatimSymlinks: true });
    return destination;
  }

  private isWithinSource(path: string): boolean {
    const relativePath = relative(resolve(this.sourceDirectory), resolve(path));
    return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
}
