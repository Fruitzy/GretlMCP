export const SERVER_NAME = "gretl-mcp";
export const SERVER_VERSION = "0.2.1";

export type CliOptions = {
  action: "run" | "help" | "version";
  gretlCliPath?: string;
  gretlGuiPath?: string;
  workspaceRoot?: string;
  enforceGuiOnly?: boolean;
};

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    action: "run"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return { action: "help" };
    }

    if (arg === "--version" || arg === "-V") {
      return { action: "version" };
    }

    if (arg === "--gretl-cli") {
      options.gretlCliPath = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--gretl-cli=")) {
      options.gretlCliPath = readInlineValue(arg);
      continue;
    }

    if (arg === "--gretl-gui") {
      options.gretlGuiPath = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--gretl-gui=")) {
      options.gretlGuiPath = readInlineValue(arg);
      continue;
    }

    if (arg === "--workspace") {
      options.workspaceRoot = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      options.workspaceRoot = readInlineValue(arg);
      continue;
    }

    if (arg === "--enforce-gui-only") {
      options.enforceGuiOnly = true;
      continue;
    }

    if (arg === "--allow-headless") {
      options.enforceGuiOnly = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function applyCliOptions(options: CliOptions): void {
  if (options.gretlCliPath) {
    process.env.GRETL_CLI = options.gretlCliPath;
  }

  if (options.gretlGuiPath) {
    process.env.GRETL_GUI = options.gretlGuiPath;
  }

  if (options.workspaceRoot) {
    process.env.GRETLMCP_WORKSPACE_DIR = options.workspaceRoot;
  }

  if (options.enforceGuiOnly !== undefined) {
    process.env.GRETLMCP_ENFORCE_GUI_ONLY = options.enforceGuiOnly ? "true" : "false";
  }
}

export function helpText(): string {
  return `${SERVER_NAME} ${SERVER_VERSION}

Model Context Protocol server for controlling Gretl through gretlcli.

Usage:
  gretl-mcp [options]

Options:
  --gretl-cli <path>  Path to gretlcli or gretlcli.exe.
  --gretl-gui <path>  Path to gretl or gretl.exe.
  --workspace <dir>   Directory for Gretl run workspaces and artifacts.
  --enforce-gui-only  Reject headless workflow requests and require visible Gretl GUI.
  --allow-headless    Allow CLI-only workflow success.
  -h, --help          Show this help message.
  -V, --version       Print the server version.

Environment:
  GRETL_CLI                Optional path to gretlcli.
  GRETL_GUI                Optional path to gretl GUI.
  GRETLMCP_WORKSPACE_DIR   Optional workspace directory.
  GRETLMCP_ENFORCE_GUI_ONLY Enforce visible GUI-only workflow success.
`;
}

function readOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }

  return value;
}

function readInlineValue(arg: string): string {
  const [, value] = arg.split("=", 2);
  if (!value) {
    throw new Error(`Missing value for ${arg}`);
  }

  return value;
}
