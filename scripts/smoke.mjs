import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env
  }
});

const client = new Client({
  name: "gretl-mcp-smoke",
  version: "0.1.0"
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const requiredTools = [
    "gretl_dataset_summary",
    "gretl_help",
    "gretl_ols",
    "gretl_run_script",
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

  const scriptRun = await client.callTool({
    name: "gretl_run_script",
    arguments: {
      script: "nulldata 8\nseries x = normal()\nsummary x",
      keepWorkspace: false
    }
  });
  const scriptText = readText(scriptRun);
  if (!scriptText.match(/Summary statistics/i)) {
    throw new Error("gretl_run_script did not execute the sample Gretl script.");
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
