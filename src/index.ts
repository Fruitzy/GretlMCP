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
  buildDatasetSummaryScript,
  buildHelpScript,
  buildOlsScript,
  resolveExistingDatasetPath,
  runGretlScript,
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
      .describe("Optional explicit path to gretl or gretl.exe.")
  },
  async ({ gretlGuiPath }) => {
    const result = await runGretlGuiVersion(gretlGuiPath);

    return asMcpText({
      ok: result.exitCode === 0,
      gretlGuiPath: result.command,
      args: result.args,
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
  "Run a Gretl/Hansl script through gretlcli, and open the same script in the visible Gretl GUI by default.",
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
    const result = await runGretlScript(input);
    const gretlGui = await maybeOpenInGretl(input);

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
  } catch (error) {
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
}

async function maybeOpenInGretl(input: {
  script: string;
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
      script: input.script,
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
