# Contributing

Thanks for improving Gretl MCP.

## Local Setup

```powershell
npm install
npm run build
npm test
npm run smoke
```

Set `GRETL_CLI` if `gretlcli` is not on PATH:

```powershell
$env:GRETL_CLI = "C:\Users\YOUR_USER\tools\gretl\gretlcli.exe"
```

## Development Notes

- Prefer wrapping Gretl's scriptable behavior over GUI automation.
- Keep advanced access in `gretl_run_script`.
- Add focused helper tools for common workflows when they reduce prompt burden.
- Keep shell execution out of Node. Use `spawn` with argument arrays.
- Tests that depend on Gretl should run through `gretlcli`.
