# Tools

## gretl_version

Checks that `gretlcli` is available and returns Gretl output.

## gretl_run_script

Runs a Gretl/Hansl script. This is the advanced tool that lets an MCP client control
most Gretl functionality exposed through scripting.

Inputs:

- `script`: Gretl/Hansl script.
- `timeoutSeconds`: Optional timeout, maximum 300 seconds.
- `safeMode`: Defaults to true. Blocks shell-like commands and absolute file writes.
- `keepWorkspace`: Defaults to true. Keeps generated files available.
- `workspaceRoot`: Optional parent directory for run workspaces.
- `gretlCliPath`: Optional path to `gretlcli`.

Prefer the high-level dataset tools for untrusted prompts. Use
`gretl_run_script` for trusted local scripts or advanced Gretl workflows.

## gretl_help

Returns Gretl help for a command name.

## gretl_gui_version

Checks that the visible Gretl GUI executable is available.

## gretl_gui_launch

Launches the real Gretl desktop GUI. It can:

- Open a local dataset or script file.
- Run a provided Gretl/Hansl script on startup using `gretl.exe --run`.
- Force English UI labels.
- Start a new GUI instance or reuse an existing one.

This opens Gretl visually for the user. It does not provide screenshot
inspection or menu-click automation by itself; those require an MCP client or
agent with desktop automation capability.

## gretl_dataset_summary

Opens a Gretl-supported dataset and returns summary statistics plus correlations.
The path must point to an existing local file; URLs are rejected.

## gretl_ols

Opens a dataset and estimates an OLS model.
The path must point to an existing local file; URLs are rejected.

## Safety Model

This server starts in a conservative mode for arbitrary scripts. Safe mode blocks
common shell escape patterns and absolute input/output paths. It is not a full
security sandbox. Run with `safeMode: false` only for trusted local files and scripts.
