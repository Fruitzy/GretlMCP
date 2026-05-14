import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    GRETLMCP_OPEN_GUI: "false"
  }
});

const client = new Client({
  name: "gretl-mcp-smoke",
  version: "0.2.0"
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const requiredTools = [
    "gretl_capabilities",
    "gretl_dataset_summary",
    "gretl_gui_launch",
    "gretl_gui_version",
    "gretl_help",
    "gretl_make_package",
    "gretl_ols",
    "gretl_package",
    "gretl_run_commands",
    "gretl_run_script",
    "gretl_run_script_file",
    "gretl_version"
  ];

  for (const toolName of requiredTools) {
    if (!toolNames.includes(toolName)) {
      throw new Error(`Missing MCP tool: ${toolName}`);
    }
  }

  const version = await client.callTool({
    name: "gretl_version",
    arguments: {}
  });
  const versionText = readText(version);
  if (!versionText.includes("gretl version")) {
    throw new Error("gretl_version did not return Gretl version text.");
  }

  const guiVersion = await client.callTool({
    name: "gretl_gui_version",
    arguments: {}
  });
  const guiVersionText = readText(guiVersion);
  if (!guiVersionText.includes("gretl version")) {
    throw new Error("gretl_gui_version did not return Gretl version text.");
  }

  const scriptRun = await client.callTool({
    name: "gretl_run_script",
    arguments: {
      script: "nulldata 8\nseries x = normal()\nsummary x",
      keepWorkspace: false,
      displayInGretl: false
    }
  });
  const scriptText = readText(scriptRun);
  if (!scriptText.match(/Summary statistics/i)) {
    throw new Error("gretl_run_script did not execute the sample Gretl script.");
  }
  const scriptPayload = JSON.parse(scriptText);
  if (scriptPayload.gretlGui?.opened !== false) {
    throw new Error("smoke test expected Gretl GUI display to be disabled.");
  }

  const commandsRun = await client.callTool({
    name: "gretl_run_commands",
    arguments: {
      commands: ["nulldata 8", "series x = normal()", "summary x"],
      keepWorkspace: false,
      displayInGretl: false
    }
  });
  if (!readText(commandsRun).match(/Summary statistics/i)) {
    throw new Error("gretl_run_commands did not execute the sample commands.");
  }

  const capabilities = await client.callTool({
    name: "gretl_capabilities",
    arguments: {
      includeFunctions: false,
      includePackageHelp: false,
      displayInGretl: false
    }
  });
  if (!readText(capabilities).includes("Valid gretl commands")) {
    throw new Error("gretl_capabilities did not return Gretl command help.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "gretl-mcp-smoke-"));
  try {
    const scriptPath = join(tempDir, "sample.inp");
    await writeFile(
      scriptPath,
      "nulldata 8\nseries x = normal()\nsummary x\n",
      "utf8"
    );

    const scriptFileRun = await client.callTool({
      name: "gretl_run_script_file",
      arguments: {
        scriptPath,
        displayInGretl: false
      }
    });
    if (!readText(scriptFileRun).match(/Summary statistics/i)) {
      throw new Error("gretl_run_script_file did not execute the sample script.");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools: toolNames
      },
      null,
      2
    )
  );
} finally {
  await client.close();
}

function readText(result) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
