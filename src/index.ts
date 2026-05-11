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
  "gretl_run_script",
  "Run a Gretl/Hansl script through gretlcli and return output plus artifact paths.",
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
      .describe("Optional explicit path to gretlcli or gretlcli.exe.")
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
    gretlCliPath: z.string().optional()
  },
  async ({ commandName, gretlCliPath }) =>
    runScriptTool({
      script: buildHelpScript(commandName),
      timeoutSeconds: 15,
      safeMode: true,
      keepWorkspace: false,
      gretlCliPath
    })
);

server.tool(
  "gretl_dataset_summary",
  "Open a Gretl-supported dataset file and return summary statistics and correlations.",
  {
    datasetPath: safePathSchema.describe(
      "Path to a CSV, gdt, Excel, Stata, SPSS, or other Gretl-supported dataset."
    ),
    timeoutSeconds: z.number().int().positive().max(300).optional(),
    safeMode: z.boolean().default(false),
    gretlCliPath: z.string().optional()
  },
  async ({ datasetPath, timeoutSeconds, safeMode, gretlCliPath }) =>
    runScriptTool({
      script: buildDatasetSummaryScript(resolveExistingDatasetPath(datasetPath)),
      timeoutSeconds,
      safeMode,
      keepWorkspace: true,
      gretlCliPath
    })
);

server.tool(
  "gretl_ols",
  "Open a dataset and estimate an OLS model.",
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
    gretlCliPath: z.string().optional()
  },
  async ({
    datasetPath,
    dependentVariable,
    independentVariables,
    includeConstant,
    timeoutSeconds,
    safeMode,
    gretlCliPath
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
      gretlCliPath
    })
);

async function runScriptTool(input: {
  script: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
}) {
  try {
    const result = await runGretlScript(input);
    return asMcpText({
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      command: result.command,
      args: result.args,
      workspace: result.workspace,
      scriptPath: result.scriptPath,
      artifacts: result.artifacts,
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
