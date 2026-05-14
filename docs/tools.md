# Tools

## gretl_version

Checks that `gretlcli` is available and returns Gretl output.

## Prompt Workflow

For broad natural-language requests, an MCP client should:

- Call `gretl_capabilities` or `gretl_help` when it needs exact Gretl syntax.
- Generate a complete Hansl script for the task.
- Run it with `gretl_run_script`, or use `gretl_run_commands` for short command
  lists.
- Read `stdout`, `stderr`, and `artifacts` from the tool result before writing
  the final answer.

## gretl_run_script

Runs a Gretl/Hansl script. This is the main prompt-to-Gretl tool: the MCP client
can translate a user request into Hansl, run it, and return Gretl output plus
generated artifacts.

Inputs:

- `script`: Gretl/Hansl script.
- `timeoutSeconds`: Optional timeout, maximum 300 seconds.
- `safeMode`: Defaults to true. Blocks shell-like commands and absolute file writes.
- `keepWorkspace`: Defaults to true. Keeps generated files available.
- `workspaceRoot`: Optional parent directory for run workspaces.
- `gretlCliPath`: Optional path to `gretlcli`.
- `displayInGretl`: Defaults to true outside CI. Opens the script in Gretl GUI.
- `gretlGuiPath`: Optional path to the visible Gretl GUI executable.
- `guiNewInstance`: Defaults to true. Opens a new Gretl GUI instance.

Prefer the high-level dataset tools for untrusted prompts. Use
`gretl_run_script` for trusted local scripts, homework-style calculations, and
advanced Gretl workflows.

## gretl_run_commands

Runs raw Gretl command lines in order. Use this when a prompt maps cleanly to
short Gretl commands and does not need a full script body.

Inputs are the same as `gretl_run_script`, except `commands` is an array of
Gretl command lines instead of `script`.

## gretl_run_script_file

Runs an existing local `.inp` file. The default working directory is the script's
own directory, which makes lecture examples and saved Gretl scripts behave like
they do when run by hand.

Inputs:

- `scriptPath`: Existing local `.inp` path.
- `workingDirectory`: Optional working directory. Defaults to the script directory.
- `scriptOpt`: Optional numeric value passed as Gretl `--scriptopt`.
- `safeMode`: Defaults to true. Validates the file before running it.
- `displayInGretl`: Defaults to true outside CI. Opens the script in Gretl GUI.

## gretl_capabilities

Runs Gretl's own help commands and returns the installed command/function
surface. Use it before unfamiliar tasks to discover the exact commands and
functions supported by the user's Gretl version.

Inputs:

- `includeFunctions`: Include `help functions`. Defaults to true.
- `includePackageHelp`: Include `help pkg` and `help makepkg`. Defaults to true.

## gretl_package

Runs the native Gretl `pkg` command. Supported actions are `install`, `query`,
`run-sample`, `unload`, `remove`, and `index`.

Inputs:

- `action`: Gretl package action.
- `packageName`: Package name, local package path, URL, or `addons` for index.
- `local`: Adds `--local` for a local `.gfn` or `.zip` package file.
- `quiet`, `verbose`, `staging`: Native `pkg` flags.

Package tools default to `displayInGretl: false`, because install/remove/build
actions have side effects. Pass `displayInGretl: true` to also open the generated
script in the GUI.

## gretl_make_package

Builds Gretl function packages using the native `makepkg` command.

Inputs:

- `packagePath`: Output path ending in `.gfn` or `.zip`.
- `index`: Adds `--index` and returns the generated XML artifact if present.
- `translations`: Adds `--translations` and returns the generated i18n artifact if present.
- `quiet`: Adds `--quiet`.

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

## Default GUI Output

Script-running tools open a visible Gretl GUI script window by default outside CI:

- `gretl_run_script`
- `gretl_run_commands`
- `gretl_run_script_file`
- `gretl_help`
- `gretl_dataset_summary`
- `gretl_ols`

To disable this default, pass `displayInGretl: false` or set
`GRETLMCP_OPEN_GUI=false`.

## gretl_dataset_summary

Opens a Gretl-supported dataset and returns summary statistics plus correlations.
The path must point to an existing local file; URLs are rejected. The same
workflow opens in Gretl GUI by default.

## gretl_ols

Opens a dataset and estimates an OLS model.
The path must point to an existing local file; URLs are rejected. The same
workflow opens in Gretl GUI by default.

## Safety Model

This server starts in a conservative mode for arbitrary scripts. Safe mode blocks
common shell escape patterns and absolute input/output paths. It is not a full
security sandbox. Run with `safeMode: false` only for trusted local files and scripts.
