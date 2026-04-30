# Install Smoke

Use this check before publishing when you want to verify the packed package the way a downstream MCP client would consume it.

## Procedure

From the repository root:

```bash
npm run build
rm -rf tmp/install-smoke
mkdir -p tmp/install-smoke/pkg tmp/install-smoke/app
npm pack --pack-destination tmp/install-smoke/pkg
cd tmp/install-smoke/app
npm init -y
npm install ../pkg/catalunya-opendata-mcp-<version>.tgz
test -x node_modules/.bin/catalunya-opendata-mcp
```

Then start the installed bin through an MCP stdio client and verify:

- `listTools` includes `ping`, `socrata_search_datasets`, `idescat_search_tables`, and `bcn_answer_city_query`.
- `callTool({ name: "ping", arguments: { name: "InstallSmoke" } })` returns `Hola, InstallSmoke. catalunya-opendata-mcp is running.`

## Latest Result

Last checked: 2026-04-30.

- Installed tarball: `catalunya-opendata-mcp-0.1.4.tgz`
- Installed bin: executable
- Registered tools: 22
- MCP ping: passed
