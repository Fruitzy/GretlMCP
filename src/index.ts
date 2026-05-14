#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SERVER_NAME,
  SERVER_VERSION,
  applyCliOptions,
  helpText,
  parseCliArgs
} from "./cli.js";
import {
  GretlSafetyError,
  buildCapabilitiesScript,
  buildDatasetSummaryScript,
  buildHelpScript,
  buildOlsScript,
  resolveExistingDatasetPath,
  runGretlCommands,
  runGretlMakePackage,
  runGretlPackage,
  runGretlScript,
  runGretlScriptFile,
  runGretlVersion
} from "./gretlRunner.js";
import { launchGretlGui, runGretlGuiVersion } from "./gretlGui.js";

try {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.action === "help") {
    console.log(helpText());
    process.exit(0);
  }

  if (cliOptions.action === "version") {
    console.log(`${SERVER_NAME} ${SERVER_VERSION}`);
    process.exit(0);
  }

  applyCliOptions(cliOptions);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

const safePathSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n"]/.test(value), {
    message: "Path cannot contain quotes or line breaks."
  });

const gretlIdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

server.tool(
  "gretl_version",
  "Return the installed Gretl version by running gretlcli.",
  {
    gretlCliPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretlcli or gretlcli.exe.")
  },
  async ({ gretlCliPath }) => {
    const result = await runGretlVersion(gretlCliPath);

    return asMcpText({
      ok: result.exitCode === 0 && !result.timedOut,
      gretlCliPath: result.command,
      args: result.args,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
);

server.tool(
  "gretl_gui_version",
  "Return the installed Gretl GUI version by running gretl.exe --version.",
  {
    gretlGuiPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretl or gretl.exe."),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(60)
      .optional()
      .describe("Maximum time to wait for gretl.exe --version. Defaults to 10 seconds.")
  },
  async ({ gretlGuiPath, timeoutSeconds }) => {
    const result = await runGretlGuiVersion(gretlGuiPath, {
      timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined
    });

    return asMcpText({
      ok: result.exitCode === 0 && !result.timedOut,
      gretlGuiPath: result.command,
      args: result.args,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
);

server.tool(
  "gretl_gui_launch",
  "Launch the visible Gretl desktop GUI, optionally opening a local dataset/script or running a provided script on startup.",
  {
    filePath: z
      .string()
      .optional()
      .describe("Optional local dataset or script file to open in the Gretl GUI."),
    script: z
      .string()
      .optional()
      .describe("Optional Gretl/Hansl script to write and open with --run in the GUI."),
    runScript: z
      .boolean()
      .default(false)
      .describe("When filePath points to a script, launch Gretl with --run filePath."),
    safeMode: z
      .boolean()
      .default(true)
      .describe("When script is provided, block shell-like commands and absolute file reads/writes."),
    newInstance: z
      .boolean()
      .default(true)
      .describe("Launch a new Gretl GUI instance instead of reusing an existing one."),
    english: z.boolean().default(true).describe("Force Gretl GUI to use English."),
    workspaceRoot: z
      .string()
      .optional()
      .describe("Optional directory where GUI script workspaces are created."),
    gretlGuiPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretl or gretl.exe.")
  },
  async (input) => {
    try {
      const result = await launchGretlGui(input);
      return asMcpText({
        ok: true,
        ...result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return asMcpText({
        ok: false,
        error: message
      });
    }
  }
);

server.tool(
  "gretl_run_script",
  "Run any Gretl/Hansl script through gretlcli. Use this as the main tool for prompt-generated Gretl workflows.",
  {
    script: z.string().min(1).describe("Gretl/Hansl script to run."),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe("Maximum runtime in seconds. Defaults to 30, max 300."),
    safeMode: z
      .boolean()
      .default(true)
      .describe("When true, blocks shell-like commands and absolute file writes."),
    keepWorkspace: z
      .boolean()
      .default(true)
      .describe("Keep the run workspace so generated artifacts remain available."),
    workspaceRoot: z
      .string()
      .optional()
      .describe("Optional directory where run workspaces are created."),
    gretlCliPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretlcli or gretlcli.exe."),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open a visible Gretl GUI script window for this run. Defaults to true outside CI."),
    gretlGuiPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretl or gretl.exe."),
    guiNewInstance: z
      .boolean()
      .default(true)
      .describe("Open a new Gretl GUI instance for the visible script.")
  },
  async (input) => runScriptTool(input)
);

server.tool(
  "gretl_run_commands",
  "Run one or more raw Gretl command lines. This is a compact alternative to gretl_run_script for prompt-generated calculations.",
  {
    commands: z
      .array(z.string().min(1))
      .min(1)
      .describe("Gretl command lines to run in order."),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe("Maximum runtime in seconds. Defaults to 30, max 300."),
    safeMode: z
      .boolean()
      .default(true)
      .describe("When true, blocks shell-like commands and absolute file writes."),
    keepWorkspace: z
      .boolean()
      .default(true)
      .describe("Keep the run workspace so generated artifacts remain available."),
    workspaceRoot: z
      .string()
      .optional()
      .describe("Optional directory where run workspaces are created."),
    gretlCliPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretlcli or gretlcli.exe."),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open the generated command script in the visible Gretl GUI. Defaults to true outside CI."),
    gretlGuiPath: z
      .string()
      .optional()
      .describe("Optional explicit path to gretl or gretl.exe."),
    guiNewInstance: z
      .boolean()
      .default(true)
      .describe("Open a new Gretl GUI instance for the visible script.")
  },
  async (input) => runCommandsTool(input)
);

server.tool(
  "gretl_run_script_file",
  "Run an existing local Gretl .inp script file with gretlcli, preserving its own working directory by default.",
  {
    scriptPath: safePathSchema.describe("Path to an existing local Gretl .inp script."),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    safeMode: z
      .boolean()
      .default(true)
      .describe("When true, validates the script before running it."),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the script. Defaults to the script file directory."),
    scriptOpt: z
      .number()
      .optional()
      .describe("Optional numeric value passed to Gretl as --scriptopt."),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open the script file in the visible Gretl GUI after running. Defaults to true outside CI."),
    gretlGuiPath: z.string().optional(),
    guiNewInstance: z.boolean().default(true)
  },
  async (input) => runScriptFileTool(input)
);

server.tool(
  "gretl_capabilities",
  "List Gretl commands, built-in functions, and package-management help from the installed Gretl version.",
  {
    includeFunctions: z
      .boolean()
      .default(true)
      .describe("Include Gretl's built-in accessors and functions from help functions."),
    includePackageHelp: z
      .boolean()
      .default(true)
      .describe("Include help for pkg and makepkg."),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open the generated help script in Gretl GUI. Defaults to false for this reference tool."),
    gretlGuiPath: z.string().optional()
  },
  async ({ includeFunctions, includePackageHelp, timeoutSeconds, gretlCliPath, displayInGretl, gretlGuiPath }) =>
    runScriptTool({
      script: buildCapabilitiesScript({ includeFunctions, includePackageHelp }),
      timeoutSeconds: timeoutSeconds ?? 30,
      safeMode: true,
      keepWorkspace: false,
      gretlCliPath,
      displayInGretl: displayInGretl ?? false,
      gretlGuiPath
    })
);

server.tool(
  "gretl_package",
  "Install, query, run samples for, unload, remove, or index Gretl function/data packages using the native pkg command.",
  {
    action: z
      .enum(["install", "query", "run-sample", "unload", "remove", "index"])
      .describe("Gretl pkg action to perform."),
    packageName: z
      .string()
      .optional()
      .describe("Package name, local package path, URL, or addons for index. Required except index defaults to addons."),
    local: z.boolean().default(false).describe("Use pkg --local for a local .gfn or .zip package file."),
    quiet: z.boolean().default(false).describe("Use pkg --quiet."),
    verbose: z.boolean().default(false).describe("Use pkg --verbose."),
    staging: z.boolean().default(false).describe("Use pkg --staging for package installs from Gretl staging."),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    keepWorkspace: z.boolean().default(true),
    workspaceRoot: z.string().optional(),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open the generated package command script in Gretl GUI. Defaults to false for package actions."),
    gretlGuiPath: z.string().optional(),
    guiNewInstance: z.boolean().default(true)
  },
  async (input) => runPackageTool(input)
);

server.tool(
  "gretl_make_package",
  "Build a Gretl function package (.gfn or .zip) using the native makepkg command.",
  {
    packagePath: safePathSchema.describe("Output path ending in .gfn or .zip."),
    index: z.boolean().default(false).describe("Write the auxiliary package XML index file."),
    translations: z.boolean().default(false).describe("Write the auxiliary i18n C strings file."),
    quiet: z.boolean().default(false).describe("Use makepkg --quiet."),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    keepWorkspace: z.boolean().default(true),
    workspaceRoot: z.string().optional(),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open the generated makepkg script in Gretl GUI. Defaults to false for package building."),
    gretlGuiPath: z.string().optional(),
    guiNewInstance: z.boolean().default(true)
  },
  async (input) => runMakePackageTool(input)
);

server.tool(
  "gretl_help",
  "Ask Gretl for command help, for example ols, summary, open, arima, or gnuplot.",
  {
    commandName: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .describe("Gretl command name."),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open a visible Gretl GUI script window for this help request. Defaults to true outside CI."),
    gretlGuiPath: z.string().optional()
  },
  async ({ commandName, gretlCliPath, displayInGretl, gretlGuiPath }) =>
    runScriptTool({
      script: buildHelpScript(commandName),
      timeoutSeconds: 15,
      safeMode: true,
      keepWorkspace: false,
      gretlCliPath,
      displayInGretl,
      gretlGuiPath
    })
);

server.tool(
  "gretl_dataset_summary",
  "Open a Gretl-supported dataset file, return summary statistics, and open the same workflow in Gretl GUI by default.",
  {
    datasetPath: safePathSchema.describe(
      "Path to a CSV, gdt, Excel, Stata, SPSS, or other Gretl-supported dataset."
    ),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    safeMode: z.boolean().default(false),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open a visible Gretl GUI script window for this workflow. Defaults to true outside CI."),
    gretlGuiPath: z.string().optional(),
    guiNewInstance: z.boolean().default(true)
  },
  async ({
    datasetPath,
    timeoutSeconds,
    safeMode,
    gretlCliPath,
    displayInGretl,
    gretlGuiPath,
    guiNewInstance
  }) =>
    runScriptTool({
      script: buildDatasetSummaryScript(resolveExistingDatasetPath(datasetPath)),
      timeoutSeconds,
      safeMode,
      keepWorkspace: true,
      gretlCliPath,
      displayInGretl,
      gretlGuiPath,
      guiNewInstance
    })
);

server.tool(
  "gretl_ols",
  "Open a dataset, estimate an OLS model, and open the same workflow in Gretl GUI by default.",
  {
    datasetPath: safePathSchema.describe("Path to a Gretl-supported dataset."),
    dependentVariable: gretlIdentifierSchema.describe("Dependent variable name."),
    independentVariables: z
      .array(gretlIdentifierSchema)
      .min(1)
      .describe("Independent variable names."),
    includeConstant: z.boolean().default(true),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    safeMode: z.boolean().default(false),
    gretlCliPath: z.string().optional(),
    displayInGretl: z
      .boolean()
      .optional()
      .describe("Open a visible Gretl GUI script window for this workflow. Defaults to true outside CI."),
    gretlGuiPath: z.string().optional(),
    guiNewInstance: z.boolean().default(true)
  },
  async ({
    datasetPath,
    dependentVariable,
    independentVariables,
    includeConstant,
    timeoutSeconds,
    safeMode,
    gretlCliPath,
    displayInGretl,
    gretlGuiPath,
    guiNewInstance
  }) =>
    runScriptTool({
      script: buildOlsScript(
        resolveExistingDatasetPath(datasetPath),
        dependentVariable,
        independentVariables,
        includeConstant
      ),
      timeoutSeconds,
      safeMode,
      keepWorkspace: true,
      gretlCliPath,
      displayInGretl,
      gretlGuiPath,
      guiNewInstance
    })
);

async function runScriptTool(input: {
  script: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  try {
    const result = await runGretlScript(retainWorkspaceForGui(input));
    return formatGretlRunResult(result, input);
  } catch (error) {
    return formatToolError(error);
  }
}

async function runCommandsTool(input: {
  commands: string[];
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  try {
    const result = await runGretlCommands(retainWorkspaceForGui(input));
    return formatGretlRunResult(result, input);
  } catch (error) {
    return formatToolError(error);
  }
}

async function runScriptFileTool(input: {
  scriptPath: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  workingDirectory?: string;
  scriptOpt?: number;
  gretlCliPath?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  try {
    const result = await runGretlScriptFile(input);
    const gretlGui = await maybeOpenInGretl({
      scriptPath: result.scriptPath,
      displayInGretl: input.displayInGretl,
      gretlGuiPath: input.gretlGuiPath,
      guiNewInstance: input.guiNewInstance
    });

    return asMcpText({
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      command: result.command,
      args: result.args,
      workingDirectory: result.workingDirectory,
      scriptPath: result.scriptPath,
      artifacts: result.artifacts,
      gretlGui,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    return formatToolError(error);
  }
}

async function runPackageTool(input: {
  action: "install" | "query" | "run-sample" | "unload" | "remove" | "index";
  packageName?: string;
  local?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  staging?: boolean;
  timeoutSeconds?: number;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  try {
    const guiInput = {
      ...input,
      displayInGretl: input.displayInGretl ?? false
    };
    const result = await runGretlPackage(retainWorkspaceForGui(guiInput));
    return formatGretlRunResult(result, guiInput);
  } catch (error) {
    return formatToolError(error);
  }
}

async function runMakePackageTool(input: {
  packagePath: string;
  index?: boolean;
  translations?: boolean;
  quiet?: boolean;
  timeoutSeconds?: number;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  try {
    const guiInput = {
      ...input,
      displayInGretl: input.displayInGretl ?? false
    };
    const result = await runGretlMakePackage(retainWorkspaceForGui(guiInput));
    return formatGretlRunResult(result, guiInput);
  } catch (error) {
    return formatToolError(error);
  }
}

function retainWorkspaceForGui<T extends { keepWorkspace?: boolean; displayInGretl?: boolean }>(
  input: T
): T {
  if (input.keepWorkspace === false && shouldDisplayInGretl(input.displayInGretl).enabled) {
    return {
      ...input,
      keepWorkspace: true
    };
  }

  return input;
}

async function formatGretlRunResult(
  result: {
    exitCode: number | null;
    timedOut: boolean;
    command: string;
    args: string[];
    workspace: string;
    scriptPath: string;
    artifacts: unknown[];
    stdout: string;
    stderr: string;
  },
  guiInput: {
    displayInGretl?: boolean;
    gretlGuiPath?: string;
    guiNewInstance?: boolean;
  }
) {
  const gretlGui = await maybeOpenInGretl({
    scriptPath: result.scriptPath,
    displayInGretl: guiInput.displayInGretl,
    gretlGuiPath: guiInput.gretlGuiPath,
    guiNewInstance: guiInput.guiNewInstance
  });

  return asMcpText({
    ok: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    command: result.command,
    args: result.args,
    workspace: result.workspace,
    scriptPath: result.scriptPath,
    artifacts: result.artifacts,
    gretlGui,
    stdout: result.stdout,
    stderr: result.stderr
  });
}

function formatToolError(error: unknown) {
  if (error instanceof GretlSafetyError) {
    return asMcpText({
      ok: false,
      error: error.message,
      hint: "Set safeMode to false only when running trusted local Gretl scripts."
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return asMcpText({
    ok: false,
    error: message
  });
}

async function maybeOpenInGretl(input: {
  script?: string;
  scriptPath?: string;
  safeMode?: boolean;
  workspaceRoot?: string;
  displayInGretl?: boolean;
  gretlGuiPath?: string;
  guiNewInstance?: boolean;
}) {
  const decision = shouldDisplayInGretl(input.displayInGretl);
  if (!decision.enabled) {
    return {
      opened: false,
      reason: decision.reason
    };
  }

  try {
    const result = await launchGretlGui({
      filePath: input.scriptPath,
      script: input.scriptPath ? undefined : input.script,
      runScript: Boolean(input.scriptPath),
      safeMode: input.safeMode,
      workspaceRoot: input.workspaceRoot,
      gretlGuiPath: input.gretlGuiPath,
      newInstance: input.guiNewInstance ?? true
    });

    return {
      opened: true,
      ...result
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      opened: false,
      error: message
    };
  }
}

function shouldDisplayInGretl(requested?: boolean): {
  enabled: boolean;
  reason?: string;
} {
  if (requested !== undefined) {
    return requested
      ? { enabled: true }
      : { enabled: false, reason: "disabled by tool argument displayInGretl=false" };
  }

  const envValue = process.env.GRETLMCP_OPEN_GUI;
  if (envValue !== undefined) {
    if (/^(0|false|no|off)$/i.test(envValue)) {
      return {
        enabled: false,
        reason: "disabled by GRETLMCP_OPEN_GUI"
      };
    }

    if (/^(1|true|yes|on)$/i.test(envValue)) {
      return { enabled: true };
    }
  }

  if (process.env.CI) {
    return {
      enabled: false,
      reason: "disabled automatically in CI"
    };
  }

  return { enabled: true };
}

function asMcpText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

await server.connect(new StdioServerTransport());
