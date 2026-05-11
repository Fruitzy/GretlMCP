# Gretl MCP

Gretl MCP is a Model Context Protocol server for controlling
[Gretl](https://gretl.sourceforge.net/) econometrics workflows through
`gretlcli`.

It lets MCP clients run Gretl/Hansl scripts, inspect Gretl help, summarize
datasets, and estimate OLS models. The generic `gretl_run_script` tool is the
advanced path for using Gretl's native scripting surface.

## Key Features

- Scriptable Gretl control through `gretlcli`.
- Optional visible Gretl GUI launch mode through `gretl.exe`.
- High-level tools for version checks, command help, dataset summaries, and OLS.
- Advanced `gretl_run_script` tool for trusted Hansl workflows.
- Stdio transport, compatible with common MCP clients.
- Safe defaults for arbitrary scripts, with documented escape hatches.

## Requirements

- Node.js 20 or newer.
- Gretl 2026b or newer with `gretlcli` available.
- An MCP client that supports stdio servers.

## Install Gretl

Windows users can download Gretl from the official Windows page:

https://gretl.sourceforge.net/win32/

For a no-admin setup, extract the zip archive to:

```text
C:\Users\YOUR_USER\tools\gretl
```

Verify Gretl:

```powershell
& C:\Users\YOUR_USER\tools\gretl\gretlcli.exe --version
```

## Getting Started

After the npm package is published, the standard MCP config is:

```json
{
  "mcpServers": {
    "gretl": {
      "command": "npx",
      "args": ["-y", "gretl-mcp@latest"],
      "env": {
        "GRETL_CLI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe"
      }
    }
  }
}
```

Until npm publishing is complete, use the GitHub install path:

```powershell
git clone https://github.com/Fruitzy/GretlMCP.git
cd GretlMCP
npm install
npm run build
```

Then point your MCP client at the built server:

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

## Client Setup

### Claude Code

```powershell
claude mcp add gretl npx -y gretl-mcp@latest
```

For local development:

```powershell
claude mcp add gretl node C:\Users\YOUR_USER\GretlMCP\dist\index.js
```

### Codex

```toml
[mcp_servers.gretl]
command = "npx"
args = ["-y", "gretl-mcp@latest"]

[mcp_servers.gretl.env]
GRETL_CLI = "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe"
```

### Cursor, Windsurf, Cline, and similar clients

Use the standard JSON config above. If the client asks for a command and args
separately, use:

```text
command: npx
args: -y gretl-mcp@latest
```

### VS Code

```powershell
code --add-mcp "{\"name\":\"gretl\",\"command\":\"npx\",\"args\":[\"-y\",\"gretl-mcp@latest\"],\"env\":{\"GRETL_CLI\":\"C:\\\\Users\\\\YOUR_USER\\\\tools\\\\gretl\\\\gretlcli.exe\"}}"
```

## Configuration

`gretl-mcp` supports environment variables and CLI flags.

Environment variables:

- `GRETL_CLI`: optional path to `gretlcli` or `gretlcli.exe`.
- `GRETL_GUI`: optional path to `gretl` or `gretl.exe`.
- `GRETLMCP_WORKSPACE_DIR`: optional directory for Gretl run workspaces.
- `GRETLMCP_OPEN_GUI`: set to `false` to stop tools from opening Gretl windows by default.

CLI options:

```powershell
gretl-mcp --gretl-cli C:\Users\YOUR_USER\tools\gretl\gretlcli.exe
gretl-mcp --gretl-gui C:\Users\YOUR_USER\tools\gretl\gretl.exe
gretl-mcp --workspace C:\Users\YOUR_USER\gretl-mcp-runs
gretl-mcp --help
gretl-mcp --version
```

## Tools

- `gretl_version`: checks Gretl availability.
- `gretl_gui_version`: checks Gretl GUI availability.
- `gretl_gui_launch`: launches the visible Gretl desktop GUI.
- `gretl_run_script`: runs a Gretl/Hansl script and returns output/artifacts.
- `gretl_help`: returns Gretl help for a command.
- `gretl_dataset_summary`: opens a local dataset and returns summary statistics.
- `gretl_ols`: opens a local dataset and estimates an OLS model.

## Safety

`gretl_run_script` defaults to `safeMode: true`, which blocks common shell-like
commands and absolute file reads/writes. This is a guardrail, not a complete
sandbox. Use `safeMode: false` only for trusted local work.

Dataset helper tools reject URLs and require paths to existing local files.

## GUI Mode

By default, the analysis tools open their generated Hansl script in the real
Gretl desktop app while also returning structured MCP output. This means prompts
such as "run OLS" or "summarize this dataset" produce the normal text result for
the agent and a visible Gretl script window for the user.

Set `displayInGretl: false` on a tool call, or set
`GRETLMCP_OPEN_GUI=false`, to disable this behavior.

`gretl_gui_launch` can also be called directly. It starts the real Gretl desktop
application, opens a local dataset/script file, or writes a prompted Hansl script
and launches Gretl with `--run`.

This is not full click-by-click GUI control by itself. If you want the agent to
observe screenshots, click menus, and make choices exactly like a human, the MCP
client also needs desktop automation or computer-use capability. Gretl MCP now
provides the Gretl-side launch surface for that workflow.

## Local Development

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run smoke
```

Run the built server:

```powershell
node dist/index.js
```

## Publishing

This project is structured for GitHub, npm, and MCP Registry metadata:

- GitHub hosts source code, issues, docs, releases, and CI.
- npm provides the easiest user install path with `npx gretl-mcp@latest`.
- `server.template.json` is ready to become `server.json` for registry publish.

Before publishing to npm or the MCP Registry, review `docs/publishing.md`.
