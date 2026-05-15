# Publishing

This repo is set up for the practical publishing path:

1. GitHub hosts the source, issues, docs, releases, and CI.
2. npm hosts the installable package.
3. The MCP Registry hosts metadata after the npm package is published.

## Before Publishing

Review every placeholder:

- `YOUR_USER`
- `YOUR_NPM_USERNAME`, only if you choose a scoped npm package

Files to update:

- `README.md`
- `examples/mcp-config.json`

If you want a scoped npm package, rename the package from `gretl-mcp` to
`@YOUR_NPM_USERNAME/gretl-mcp` and update `server.json` plus
`server.template.json`.

## GitHub

Create a new public GitHub repository, then push:

```powershell
git remote add origin https://github.com/OndrejLapes/GretlMCP.git
git branch -M main
git push -u origin main
```

## npm

```powershell
npm login
npm run build
npm test
npm run smoke
npm pack --dry-run
npm publish --access public
```

After publish, verify the install path:

```powershell
npx -y gretl-mcp@latest --version
```

If `npm publish` fails with auth or 2FA prompts, complete those in your terminal
and rerun the same command.

## MCP Registry

The MCP Registry requires npm metadata verification. The `mcpName` field in
`package.json` must exactly match the `name` field in `server.json`.

Then replace placeholders and publish with the official `mcp-publisher` tool:

```powershell
mcp-publisher login github
mcp-publisher publish
```

The registry is still marked as preview by the official MCP docs, so expect some
metadata or CLI workflow changes over time.
