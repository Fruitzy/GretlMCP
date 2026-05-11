import { spawn } from "node:child_process";
import { constants, existsSync, statSync } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export type GretlRunOptions = {
  script: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
};

export type GretlRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  workspace: string;
  scriptPath: string;
  artifacts: GretlArtifact[];
};

export type GretlVersionResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type GretlArtifact = {
  path: string;
  name: string;
  sizeBytes: number;
};

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const UNSAFE_LINE_PATTERNS: RegExp[] = [
  /^\s*!/,
  /^\s*shell\b/i,
  /^\s*system\b/i,
  /^\s*foreign\b/i,
  /^\s*open\s+["']?(?:[a-zA-Z]:[\\/]|\\\\|\/)/i,
  /^\s*(?:store|outfile)\s+["']?(?:[a-zA-Z]:[\\/]|\\\\|\/)/i
];

const GRETL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class GretlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GretlSafetyError";
  }
}

export function resolveGretlCli(explicitPath?: string): string {
  const envPath = process.env.GRETL_CLI ?? process.env.GRETLMCP_GRETCLI;
  const candidates = [
    explicitPath,
    envPath,
    localWindowsPortablePath(),
    "C:\\Program Files\\gretl\\gretlcli.exe",
    "C:\\Program Files (x86)\\gretl\\gretlcli.exe",
    "gretlcli"
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (looksLikePath(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? "gretlcli";
}

export async function assertGretlCliAvailable(gretlCliPath?: string): Promise<string> {
  const command = resolveGretlCli(gretlCliPath);
  if (!looksLikePath(command)) {
    return command;
  }

  await access(command, constants.X_OK);
  return command;
}

export function validateSafeScript(script: string): void {
  const lines = script.split(/\r?\n/);
  const unsafeLine = lines.find((line) =>
    UNSAFE_LINE_PATTERNS.some((pattern) => pattern.test(line))
  );

  if (unsafeLine) {
    throw new GretlSafetyError(
      `Safe mode blocked this Gretl command: ${unsafeLine.trim()}`
    );
  }
}

export async function runGretlScript(options: GretlRunOptions): Promise<GretlRunResult> {
  const safeMode = options.safeMode ?? true;
  if (safeMode) {
    validateSafeScript(options.script);
  }

  const timeoutSeconds = clampTimeout(options.timeoutSeconds);
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  await mkdir(workspaceRoot, { recursive: true });

  const workspace = join(
    workspaceRoot,
    `gretl-run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  await mkdir(workspace, { recursive: true });

  const scriptPath = join(workspace, "script.inp");
  await writeFile(scriptPath, normalizeScript(options.script), "utf8");

  const command = await assertGretlCliAvailable(options.gretlCliPath);
  const args = ["--english", "--quiet", "--batch", scriptPath];
  const result = await runProcess(command, args, workspace, timeoutSeconds);
  const artifacts = await collectArtifacts(workspace, scriptPath);

  if (!options.keepWorkspace && artifacts.length === 0) {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    workspace,
    scriptPath,
    artifacts
  };
}

export async function runGretlVersion(gretlCliPath?: string): Promise<GretlVersionResult> {
  const command = await assertGretlCliAvailable(gretlCliPath);
  const args = ["--version"];
  const result = await runProcess(command, args, process.cwd(), 15);

  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function buildDatasetSummaryScript(datasetPath: string): string {
  return [
    `open ${quoteGretlPath(datasetPath)}`,
    "summary",
    "corr"
  ].join(EOL);
}

export function resolveExistingDatasetPath(datasetPath: string): string {
  if (/[\r\n"]/.test(datasetPath)) {
    throw new Error("Dataset paths cannot contain quotes or line breaks.");
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(datasetPath)) {
    throw new Error("Dataset paths must be local files, not URLs.");
  }

  const resolvedPath = resolve(datasetPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Dataset file does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`Dataset path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

export function buildOlsScript(
  datasetPath: string,
  dependentVariable: string,
  independentVariables: string[],
  includeConstant = true
): string {
  assertGretlIdentifier(dependentVariable);
  for (const independentVariable of independentVariables) {
    assertGretlIdentifier(independentVariable);
  }

  const regressors = [
    includeConstant ? "const" : undefined,
    ...independentVariables
  ].filter(Boolean);

  return [
    `open ${quoteGretlPath(datasetPath)}`,
    `ols ${dependentVariable} ${regressors.join(" ")}`
  ].join(EOL);
}

export function buildHelpScript(commandName: string): string {
  assertGretlIdentifier(commandName);
  return `help ${commandName}`;
}

export function assertGretlIdentifier(value: string): void {
  if (!GRETL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid Gretl identifier: ${value}`);
  }
}

function localWindowsPortablePath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return undefined;
  }

  return join(userProfile, "tools", "gretl", "gretlcli.exe");
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes(sep) || /[a-zA-Z]:\\/.test(value);
}

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return resolve(
    workspaceRoot ??
      process.env.GRETLMCP_WORKSPACE_DIR ??
      join(process.cwd(), ".gretl-mcp-runs")
  );
}

function clampTimeout(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return Math.min(Math.floor(timeoutSeconds), MAX_TIMEOUT_SECONDS);
}

function normalizeScript(script: string): string {
  const trimmed = script.trim();
  return `${trimmed}${EOL}`;
}

function quoteGretlPath(path: string): string {
  if (/[\r\n"]/.test(path)) {
    throw new Error("Dataset paths cannot contain quotes or line breaks.");
  }

  return `"${path.replace(/\\/g, "/")}"`;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number
): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, timedOut, stdout, stderr });
    });
  });
}

async function collectArtifacts(workspace: string, scriptPath: string): Promise<GretlArtifact[]> {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  const artifacts: GretlArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const path = join(entry.parentPath ?? workspace, entry.name);
    if (path === scriptPath) {
      continue;
    }

    const fileStat = await stat(path);
    artifacts.push({
      path,
      name: basename(path),
      sizeBytes: fileStat.size
    });
  }

  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}
