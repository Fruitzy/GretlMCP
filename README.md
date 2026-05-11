# Gretl MCP

Gretl MCP is a Model Context Protocol server for controlling
[Gretl](https://gretl.sourceforge.net/) through `gretlcli`.

It lets MCP clients run Gretl/Hansl scripts, inspect Gretl help, summarize datasets,
and estimate OLS models. The generic `gretl_run_script` tool is the main path for
advanced control, similar in spirit to design-app MCP servers that expose the host
application's native automation surface.

## Status

Early project. The server works locally with Gretl 2026b and Node.js 24 on Windows.

## Requirements

- Node.js 20 or newer.
- Gretl with `gretlcli` available.
- An MCP client that supports stdio servers.

## Quick Start

Install Gretl first. On Windows without admin rights, download the zip from the
official Gretl Windows page and extract it to `C:\Users\YOUR_USER\tools\gretl`.

```powershell
& C:\Users\YOUR_USER\tools\gretl\gretlcli.exe --version
```

Use directly from GitHub:

```powershell
git clone https://github.com/Fruitzy/GretlMCP.git
cd GretlMCP
npm install
npm run build
```

Example MCP config for the cloned repo:

```json
{
  "mcpServers": {
    "gretl": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USER\\GretlMCP\\dist\\index.js"],
      "env": {
        "GRETL_CLI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe"
      }
    }
  }
}
```

After npm publication, users can run it with `npx`:

```json
{
  "mcpServers": {
    "gretl": {
      "command": "npx",
      "args": ["gretl-mcp"],
      "env": {
        "GRETL_CLI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe"
      }
    }
  }
}
```

## Local Development

```powershell
npm install
npm run build
npm test
```

Run the built server:

```powershell
node dist/index.js
```

## Tools

- `gretl_version`: checks Gretl availability.
- `gretl_run_script`: runs a Gretl/Hansl script and returns output/artifacts.
- `gretl_help`: returns Gretl help for a command.
- `gretl_dataset_summary`: opens a dataset and returns summary statistics.
- `gretl_ols`: opens a dataset and estimates an OLS model.

## Safety

`gretl_run_script` defaults to `safeMode: true`, which blocks shell-like commands
and absolute file reads/writes. This is a guardrail, not a complete sandbox. Use
`safeMode: false` only for trusted local work.

## Publishing

This project is structured for GitHub and npm:

- GitHub hosts source code, issues, releases, docs, and CI.
- npm provides the easiest user install path with `npx gretl-mcp` or
  `npm install -g gretl-mcp`.

Before publishing to npm or the MCP Registry, review `docs/publishing.md`.
