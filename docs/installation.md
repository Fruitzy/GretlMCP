# Installation

## Requirements

- Node.js 20 or newer.
- Gretl 2026b or newer.
- An MCP client that can run stdio MCP servers.

## Install Gretl on Windows

Download the current 64-bit Windows release from:

https://gretl.sourceforge.net/win32/

For no-admin installs, use the zip archive and extract it to:

```text
C:\Users\YOUR_USER\tools\gretl
```

Verify:

```powershell
& C:\Users\YOUR_USER\tools\gretl\gretlcli.exe --version
```

## Install Gretl MCP from npm

After npm publication, use the standard MCP config:

```json
{
  "mcpServers": {
    "gretl": {
      "command": "npx",
      "args": ["-y", "gretl-mcp@latest"],
      "env": {
        "GRETL_CLI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe",
        "GRETL_GUI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretl.exe"
      }
    }
  }
}
```

Or install globally:

```powershell
npm install -g gretl-mcp
```

## Install Gretl MCP from GitHub

```powershell
git clone https://github.com/Fruitzy/GretlMCP.git
cd GretlMCP
npm install
npm run build
```

Point your MCP client at the built server:

```json
{
  "mcpServers": {
    "gretl": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USER\\GretlMCP\\dist\\index.js"],
      "env": {
        "GRETL_CLI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretlcli.exe",
        "GRETL_GUI": "C:\\Users\\YOUR_USER\\tools\\gretl\\gretl.exe"
      }
    }
  }
}
```

If Gretl is not on PATH, set:

```powershell
$env:GRETL_CLI = "C:\Users\YOUR_USER\tools\gretl\gretlcli.exe"
$env:GRETL_GUI = "C:\Users\YOUR_USER\tools\gretl\gretl.exe"
```

By default, script-running tools open a visible Gretl GUI window. To disable that:

```powershell
$env:GRETLMCP_OPEN_GUI = "false"
$env:GRETLMCP_REQUIRE_GUI = "false"
```

## Local Development

```powershell
npm install
npm run build
npm test
```

Use `examples/local-dev-config.json` as a starting point for local MCP client setup.
