import { spawn } from "node:child_process";
import { constants, existsSync, statSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

export type GretlRunOptions = {
  script: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
};

export type GretlCommandRunOptions = Omit<GretlRunOptions, "script"> & {
  commands: string[];
};

export type GretlScriptFileOptions = {
  scriptPath: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  workingDirectory?: string;
  scriptOpt?: number;
  gretlCliPath?: string;
};

export type GretlPackageAction =
  | "install"
  | "query"
  | "run-sample"
  | "unload"
  | "remove"
  | "index";

export type GretlPackageOptions = Omit<GretlRunOptions, "script" | "safeMode"> & {
  action: GretlPackageAction;
  packageName?: string;
  local?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  staging?: boolean;
};

export type GretlMakePackageOptions = Omit<GretlRunOptions, "script" | "safeMode"> & {
  packagePath: string;
  index?: boolean;
  translations?: boolean;
  quiet?: boolean;
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

export type GretlCliRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  workingDirectory: string;
  scriptPath?: string;
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
const PACKAGE_ACTIONS = new Set<GretlPackageAction>([
  "install",
  "query",
  "run-sample",
  "unload",
  "remove",
  "index"
]);
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

export async function runGretlCommands(
  options: GretlCommandRunOptions
): Promise<GretlRunResult> {
  return runGretlScript({
    ...options,
    script: buildCommandsScript(options.commands)
  });
}

export async function runGretlScriptFile(
  options: GretlScriptFileOptions
): Promise<GretlCliRunResult> {
  const scriptPath = resolveExistingLocalFilePath(options.scriptPath, "Script file");
  const workingDirectory = resolveExistingDirectory(
    options.workingDirectory ?? dirname(scriptPath)
  );

  const safeMode = options.safeMode ?? true;
  if (safeMode) {
    validateSafeScript(await readFile(scriptPath, "utf8"));
  }

  const timeoutSeconds = clampTimeout(options.timeoutSeconds);
  const command = await assertGretlCliAvailable(options.gretlCliPath);
  const args = ["--english", "--quiet", "--batch"];
  if (options.scriptOpt !== undefined) {
    args.push(`--scriptopt=${options.scriptOpt}`);
  }
  args.push(scriptPath);

  const result = await runProcess(command, args, workingDirectory, timeoutSeconds);
  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    workingDirectory,
    scriptPath,
    artifacts: []
  };
}

export async function runGretlPackage(
  options: GretlPackageOptions
): Promise<GretlRunResult> {
  return runGretlScript({
    ...options,
    script: buildPackageScript(options),
    safeMode: false,
    keepWorkspace: options.keepWorkspace ?? true
  });
}

export async function runGretlMakePackage(
  options: GretlMakePackageOptions
): Promise<GretlRunResult> {
  const packagePath = resolvePackageOutputPath(options.packagePath);
  const result = await runGretlScript({
    ...options,
    script: buildMakePackageScript({
      ...options,
      packagePath
    }),
    safeMode: false,
    keepWorkspace: options.keepWorkspace ?? true
  });

  const packageArtifacts = await collectPackageArtifacts(
    packagePath,
    options.index,
    options.translations
  );

  return {
    ...result,
    artifacts: mergeArtifacts(result.artifacts, packageArtifacts)
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
  return resolveExistingLocalFilePath(datasetPath, "Dataset file");
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

export function buildCapabilitiesScript(options?: {
  includeFunctions?: boolean;
  includePackageHelp?: boolean;
}): string {
  const includeFunctions = options?.includeFunctions ?? true;
  const includePackageHelp = options?.includePackageHelp ?? true;
  return [
    "help",
    includeFunctions ? "help functions" : undefined,
    includePackageHelp ? "help pkg" : undefined,
    includePackageHelp ? "help makepkg" : undefined
  ]
    .filter(Boolean)
    .join(EOL);
}

export function buildCommandsScript(commands: string[]): string {
  if (commands.length === 0) {
    throw new Error("At least one Gretl command is required.");
  }

  return commands
    .map((command) => {
      const trimmed = command.trim();
      if (!trimmed) {
        throw new Error("Gretl commands cannot be empty.");
      }
      return trimmed;
    })
    .join(EOL);
}

export function buildPackageScript(options: {
  action: GretlPackageAction;
  packageName?: string;
  local?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  staging?: boolean;
}): string {
  assertPackageAction(options.action);
  const packageName =
    options.action === "index" ? options.packageName ?? "addons" : options.packageName;

  if (!packageName) {
    throw new Error(`Package name is required for pkg ${options.action}.`);
  }

  const flags = [
    options.local ? "--local" : undefined,
    options.quiet ? "--quiet" : undefined,
    options.verbose ? "--verbose" : undefined,
    options.staging ? "--staging" : undefined
  ].filter(Boolean);

  return [`pkg ${options.action} ${quoteGretlArgument(packageName)}`, ...flags].join(" ");
}

export function buildMakePackageScript(options: {
  packagePath: string;
  index?: boolean;
  translations?: boolean;
  quiet?: boolean;
}): string {
  const packagePath = resolvePackageOutputPath(options.packagePath);
  const flags = [
    options.index ? "--index" : undefined,
    options.translations ? "--translations" : undefined,
    options.quiet ? "--quiet" : undefined
  ].filter(Boolean);

  return [`makepkg ${quoteGretlPath(packagePath)}`, ...flags].join(" ");
}

export function assertGretlIdentifier(value: string): void {
  if (!GRETL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid Gretl identifier: ${value}`);
  }
}

export function resolveExistingLocalFilePath(filePath: string, label = "File"): string {
  if (/[\r\n"]/.test(filePath)) {
    throw new Error(`${label} paths cannot contain quotes or line breaks.`);
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(filePath)) {
    throw new Error(`${label} paths must be local files, not URLs.`);
  }

  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`${label} path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

function assertPackageAction(action: GretlPackageAction): void {
  if (!PACKAGE_ACTIONS.has(action)) {
    throw new Error(`Unsupported Gretl package action: ${action}`);
  }
}

function resolveExistingDirectory(directoryPath: string): string {
  const resolvedPath = resolve(directoryPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Working directory does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Working directory path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

function resolvePackageOutputPath(packagePath: string): string {
  if (/[\r\n"]/.test(packagePath)) {
    throw new Error("Package paths cannot contain quotes or line breaks.");
  }

  const resolvedPath = resolve(packagePath);
  const extension = extname(resolvedPath).toLowerCase();
  if (extension !== ".gfn" && extension !== ".zip") {
    throw new Error("Gretl package output path must end in .gfn or .zip.");
  }

  return resolvedPath;
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
    throw new Error("Gretl paths cannot contain quotes or line breaks.");
  }

  return `"${path.replace(/\\/g, "/")}"`;
}

function quoteGretlArgument(value: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error("Gretl arguments cannot contain quotes or line breaks.");
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value)) {
    return value;
  }

  if (/^[A-Za-z0-9_.+-]+$/.test(value)) {
    return value;
  }

  return quoteGretlPath(value);
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

async function collectPackageArtifacts(
  packagePath: string,
  includeIndex?: boolean,
  includeTranslations?: boolean
): Promise<GretlArtifact[]> {
  const artifacts: GretlArtifact[] = [];
  const extension = extname(packagePath);
  const basenameWithoutExtension = packagePath.slice(0, -extension.length);
  const candidates = [
    packagePath,
    includeIndex ? `${basenameWithoutExtension}.xml` : undefined,
    includeTranslations ? `${basenameWithoutExtension}-i18n.c` : undefined
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) {
      continue;
    }

    artifacts.push({
      path: candidate,
      name: basename(candidate),
      sizeBytes: fileStat.size
    });
  }

  return artifacts;
}

function mergeArtifacts(
  primaryArtifacts: GretlArtifact[],
  secondaryArtifacts: GretlArtifact[]
): GretlArtifact[] {
  const byPath = new Map<string, GretlArtifact>();
  for (const artifact of [...primaryArtifacts, ...secondaryArtifacts]) {
    byPath.set(artifact.path, artifact);
  }

  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}
