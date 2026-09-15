import { exec, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ScopeCheckState, ScopeDefectSummary, ScopeGateResult, ScopeScenarioType } from "./contract.js";

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 120_000;
const RUN_ALIVE_MS = 5_000;
const PROJECT_MARKERS = [
  "package.json", "pom.xml", "go.mod", "pyproject.toml", "setup.py", "requirements.txt",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".azure", "__pycache__", "dist", "build"]);

export const DEFAULT_GATE_PROMPTS = {
  build: "Build this project.",
  test: "Run the tests generated for this project. If the agent generated no tests, report this check as inapplicable.",
} as const;

export function initialGates(scenarioType: ScopeScenarioType): {
  select: ScopeGateResult;
  build: ScopeGateResult;
  test: ScopeGateResult;
  run: ScopeGateResult;
} {
  const pending = (name: ScopeGateResult["name"]): ScopeGateResult => ({
    name,
    state: "prerequisite-blocked",
    reason: "Not evaluated yet",
    evidence: [],
  });
  if (scenarioType === "response") {
    const inapplicable = (name: "build" | "test" | "run"): ScopeGateResult => ({
      name,
      state: "inapplicable",
      reason: "Execution verification does not apply to response scenarios",
      evidence: [],
    });
    return { select: pending("select"), build: inapplicable("build"), test: inapplicable("test"), run: inapplicable("run") };
  }
  return { select: pending("select"), build: pending("build"), test: pending("test"), run: pending("run") };
}

export function blockedGate(
  name: "test" | "run",
  prerequisite: "build" | "test",
  state: ScopeCheckState,
): ScopeGateResult {
  return {
    name,
    state: "failed",
    reason: `${name} requires ${prerequisite} to ${prerequisite === "build" ? "pass" : "pass or be inapplicable"}; ${prerequisite} was ${state}`,
    evidence: [],
  };
}

export function shouldExecuteTest(build: ScopeGateResult): boolean {
  return build.state === "passed";
}

export function shouldExecuteRun(build: ScopeGateResult, test: ScopeGateResult): boolean {
  return build.state === "passed" && (test.state === "passed" || test.state === "inapplicable");
}

export async function executeGate(
  workspace: string,
  name: "build" | "test" | "run",
  prompt?: string,
): Promise<ScopeGateResult> {
  const projectRoot = findProjectRoot(workspace);
  if (name === "test" && !detectTestPresence(projectRoot)) {
    return gateResult(name, "inapplicable", "No tests detected", undefined, prompt);
  }

  const command = name === "build"
    ? detectBuildCommand(projectRoot)
    : name === "test"
      ? detectTestCommand(projectRoot)
      : detectStartCommand(projectRoot);
  if (!command) {
    return gateResult(
      name,
      name === "build" ? "failed" : "inapplicable",
      `Could not determine ${name} command`,
      undefined,
      prompt,
    );
  }

  if (name === "run") return executeRunGate(projectRoot, command, prompt);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    return gateResult(
      name,
      "passed",
      `${capitalize(name)} command succeeded: ${command}`,
      summarizeOutput(stdout, stderr),
      prompt,
      extractDefects(stdout, stderr),
    );
  } catch (error) {
    return gateResult(
      name,
      "failed",
      `${capitalize(name)} command failed: ${command}`,
      commandErrorOutput(error),
      prompt,
      commandErrorDefects(error),
    );
  }
}

export function findProjectRoot(workspace: string): string {
  if (hasProjectMarker(workspace)) return workspace;
  const subdirectories = childDirectories(workspace);
  for (const directory of subdirectories) {
    if (hasProjectMarker(directory)) return directory;
  }
  for (const directory of subdirectories) {
    for (const nested of childDirectories(directory)) {
      if (hasProjectMarker(nested)) return nested;
    }
  }
  return workspace;
}

export function detectBuildCommand(workspace: string): string | undefined {
  const packageJson = readPackageJson(workspace);
  if (packageJson) {
    if (packageJson.scripts?.build) return "npm run build";
    if (packageJson.scripts?.compile) return "npm run compile";
    return "npm install";
  }
  if (existsSync(join(workspace, "pom.xml"))) return "mvn compile -q";
  if (hasExtension(workspace, ".csproj") || hasExtension(workspace, ".sln")) return "dotnet build";
  if (existsSync(join(workspace, "pyproject.toml")) || existsSync(join(workspace, "setup.py"))) {
    return "pip install -e .";
  }
  if (existsSync(join(workspace, "requirements.txt"))) return "pip install -r requirements.txt";
  if (files(workspace).some((file) => file.endsWith(".py"))) return "python3 -m compileall .";
  if (existsSync(join(workspace, "go.mod"))) return "go build ./...";
  return undefined;
}

export function detectTestCommand(workspace: string): string | undefined {
  const packageJson = readPackageJson(workspace);
  if (packageJson?.scripts?.test) return "npm test";
  if (existsSync(join(workspace, "pom.xml"))) return "mvn test -q";
  if (hasExtension(workspace, ".csproj") || hasExtension(workspace, ".sln")) return "dotnet test";
  if (existsSync(join(workspace, "go.mod"))) return "go test ./...";
  if (existsSync(join(workspace, "pyproject.toml"))) return "pytest";
  return undefined;
}

export function detectStartCommand(workspace: string): string | undefined {
  const packageJson = readPackageJson(workspace);
  if (packageJson) {
    if (packageJson.scripts?.start) return "npm start";
    if (packageJson.scripts?.dev) return "npm run dev";
    if (packageJson.main) return `node ${packageJson.main}`;
  }
  if (existsSync(join(workspace, "pom.xml"))) return "mvn spring-boot:run -q";
  if (hasExtension(workspace, ".csproj") || hasExtension(workspace, ".sln")) return "dotnet run";
  if (existsSync(join(workspace, "go.mod"))) return "go run .";

  const pythonFiles = files(workspace).filter((file) => file.endsWith(".py"));
  const mainFile = pythonFiles.find((file) => {
    const content = readFileSync(join(workspace, file), "utf8");
    return content.includes("__name__") && content.includes("__main__");
  });
  if (mainFile) return `python ${mainFile}`;
  if (pythonFiles.length === 1) return `python ${pythonFiles[0]}`;

  const javascriptFiles = files(workspace).filter((file) => file.endsWith(".js"));
  if (javascriptFiles.length === 1) return `node ${javascriptFiles[0]}`;
  return undefined;
}

function detectTestPresence(workspace: string): boolean {
  if (["test", "tests", "__tests__", "spec", "specs"].some((name) => existsSync(join(workspace, name)))) {
    return true;
  }
  const testScript = readPackageJson(workspace)?.scripts?.test;
  return Boolean(testScript && testScript !== 'echo "Error: no test specified" && exit 1');
}

async function executeRunGate(
  workspace: string,
  command: string,
  prompt?: string,
): Promise<ScopeGateResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    const finish = (state: "passed" | "failed", reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(gateResult("run", state, reason, summarizeOutput(stdout, stderr), prompt));
    };
    const timer = setTimeout(() => {
      if (process.platform === "win32") child.kill();
      else if (child.pid) process.kill(-child.pid, "SIGTERM");
      finish("failed", `Run command did not exit within ${RUN_ALIVE_MS / 1000} seconds: ${command}`);
    }, RUN_ALIVE_MS);
    child.once("error", (error) => finish("failed", `Run command failed to start: ${command} (${error.message})`));
    child.once("exit", (code, signal) => {
      finish(
        code === 0 ? "passed" : "failed",
        code === 0
          ? `Run command completed successfully: ${command}`
          : `Run command exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${command}`,
      );
    });
  });
}

function gateResult(
  name: "build" | "test" | "run",
  state: "passed" | "failed" | "inapplicable",
  reason: string,
  output?: string,
  prompt?: string,
  defects?: ScopeDefectSummary,
): ScopeGateResult {
  return {
    name,
    state,
    reason,
    ...(prompt ? { prompt } : {}),
    ...(defects ? { defects } : {}),
    evidence: [{
      kind: "workspace",
      ...(output ? { description: `${reason}\n${output}` } : { description: reason }),
    }],
  };
}

function childDirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

function hasProjectMarker(directory: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(directory, marker))) ||
    files(directory).some((file) => file.endsWith(".csproj") || file.endsWith(".sln"));
}

function files(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => basename(entry.name));
  } catch {
    return [];
  }
}

interface PackageJson {
  main?: string;
  scripts?: Record<string, string>;
}

function readPackageJson(workspace: string): PackageJson | undefined {
  const path = join(workspace, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function hasExtension(workspace: string, extension: string): boolean {
  return files(workspace).some((file) => file.endsWith(extension));
}

function summarizeOutput(stdout: string, stderr: string): string | undefined {
  const output = `${stdout}${stderr}`.trim();
  return output ? output.slice(0, 2_000) : undefined;
}

function commandErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const commandError = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return summarizeOutput(String(commandError.stdout ?? ""), String(commandError.stderr ?? "")) ??
    commandError.message ?? "Command failed";
}

function commandErrorDefects(error: unknown): ScopeDefectSummary {
  if (!error || typeof error !== "object") return extractDefects("", String(error));
  const commandError = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return extractDefects(
    String(commandError.stdout ?? ""),
    String(commandError.stderr ?? commandError.message ?? ""),
  );
}

export function extractDefects(stdout: string, stderr: string): ScopeDefectSummary {
  const diagnostics = `${stdout}\n${stderr}`.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const match = trimmed.match(/\berror\s+(TS\d+|[A-Z][A-Z0-9_-]*\d+)?\s*:?\s*(.+)/i) ??
      trimmed.match(/^(SyntaxError|IndentationError|TabError|TypeError|NameError):\s*(.+)/);
    if (!match) return [];
    return [{
      category: match[1]?.toUpperCase() ?? "ERROR",
      description: (match[2] ?? trimmed).trim(),
    }];
  });
  const groups = new Map<string, { category: string; count: number; description: string }>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.category}\0${diagnostic.description}`;
    const existing = groups.get(key);
    groups.set(key, existing
      ? { ...existing, count: existing.count + 1 }
      : { ...diagnostic, count: 1 });
  }
  return {
    rawCount: diagnostics.length,
    rootCauses: [...groups.values()].sort((left, right) =>
      right.count - left.count || left.category.localeCompare(right.category) ||
      left.description.localeCompare(right.description)),
  };
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
