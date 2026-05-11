import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  validateSafeScript,
  resolveExistingDatasetPath,
  type GretlArtifact
} from "./gretlRunner.js";

export type GretlGuiLaunchOptions = {
  filePath?: string;
  script?: string;
  runScript?: boolean;
  safeMode?: boolean;
  newInstance?: boolean;
  english?: boolean;
  workspaceRoot?: string;
  gretlGuiPath?: string;
};

export type GretlGuiLaunchResult = {
  command: string;
  args: string[];
  pid: number | undefined;
  workspace?: string;
  scriptPath?: string;
  openedFilePath?: string;
  note: string;
  artifacts: GretlArtifact[];
};

const DEFAULT_NOTE =
  "Gretl GUI was launched as a visible desktop process. Further menu-click automation depends on the MCP client having desktop-control capabilities.";

export function resolveGretlGui(explicitPath?: string): string {
  const envPath = process.env.GRETL_GUI ?? process.env.GRETLMCP_GRETGUI;
  const candidates = [
    explicitPath,
    envPath,
    localWindowsPortablePath(),
    "C:\\Program Files\\gretl\\gretl.exe",
    "C:\\Program Files (x86)\\gretl\\gretl.exe",
    "gretl"
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (looksLikePath(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? "gretl";
}

export async function assertGretlGuiAvailable(gretlGuiPath?: string): Promise<string> {
  const command = resolveGretlGui(gretlGuiPath);
  if (!looksLikePath(command)) {
    return command;
  }

  await access(command, constants.X_OK);
  return command;
}

export async function launchGretlGui(
  options: GretlGuiLaunchOptions
): Promise<GretlGuiLaunchResult> {
  if (options.filePath && options.script) {
    throw new Error("Provide either filePath or script, not both.");
  }

  const command = await assertGretlGuiAvailable(options.gretlGuiPath);
  const args = await buildGuiArgs(options);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false
  });

  const spawnError = await waitForSpawn(child);
  if (spawnError) {
    throw spawnError;
  }

  child.unref();

  return {
    command,
    args,
    pid: child.pid,
    workspace: args.workspace,
    scriptPath: args.scriptPath,
    openedFilePath: args.openedFilePath,
    note: DEFAULT_NOTE,
    artifacts: []
  };
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<Error | undefined> {
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise(undefined);
    }, 250);

    const onError = (error: Error) => {
      cleanup();
      resolvePromise(error);
    };

    const onSpawn = () => {
      cleanup();
      resolvePromise(undefined);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };

    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

export async function runGretlGuiVersion(
  gretlGuiPath?: string
): Promise<{
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const command = await assertGretlGuiAvailable(gretlGuiPath);
  const args = ["--version"];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ command, args, exitCode, stdout, stderr });
    });
  });
}

async function buildGuiArgs(options: GretlGuiLaunchOptions): Promise<
  string[] & {
    workspace?: string;
    scriptPath?: string;
    openedFilePath?: string;
  }
> {
  const args = [] as string[] & {
    workspace?: string;
    scriptPath?: string;
    openedFilePath?: string;
  };

  if (options.english ?? true) {
    args.push("--english");
  }

  args.push(options.newInstance ?? true ? "--new" : "--single");

  if (options.script) {
    const safeMode = options.safeMode ?? true;
    if (safeMode) {
      validateSafeScript(options.script);
    }

    const workspace = await createGuiWorkspace(options.workspaceRoot);
    const scriptPath = join(workspace, "gui-script.inp");
    await writeFile(scriptPath, normalizeScript(options.script), "utf8");
    args.push("--run", scriptPath);
    args.workspace = workspace;
    args.scriptPath = scriptPath;
    args.openedFilePath = scriptPath;
    return args;
  }

  if (options.filePath) {
    const filePath = resolveExistingDatasetPath(options.filePath);
    if (options.runScript) {
      args.push("--run", filePath);
    } else {
      args.push(filePath);
    }

    args.openedFilePath = filePath;
  }

  return args;
}

async function createGuiWorkspace(workspaceRoot?: string): Promise<string> {
  const root = resolve(
    workspaceRoot ??
      process.env.GRETLMCP_WORKSPACE_DIR ??
      join(process.cwd(), ".gretl-mcp-runs")
  );
  await mkdir(root, { recursive: true });

  const workspace = join(
    root,
    `gretl-gui-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function localWindowsPortablePath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return undefined;
  }

  return join(userProfile, "tools", "gretl", "gretl.exe");
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes(sep) || /[a-zA-Z]:\\/.test(value);
}

function normalizeScript(script: string): string {
  const trimmed = script.trim();
  return `${trimmed}${EOL}`;
}
