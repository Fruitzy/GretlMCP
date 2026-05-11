# Security

Gretl MCP can run Gretl/Hansl scripts. Treat scripts as code.

The `gretl_run_script` tool defaults to `safeMode: true`, which blocks common
shell escape patterns and absolute file reads/writes. This is a guardrail, not a
complete sandbox.

Dataset helper tools reject URLs and require dataset paths to exist as local files
before calling Gretl.

Use `safeMode: false` only when:

- The script is trusted.
- The dataset paths are trusted.
- The MCP client is running on a machine where file access is acceptable.

Please report security issues privately to the repository owner after the GitHub
repository is created.
