# catalunya-opendata-mcp

Barebones MCP server scaffold for Catalonia open data.

This repository starts intentionally small: one runnable stdio MCP server with a `ping` tool and an `about` resource. The larger architecture lives in [`specs.md`](./specs.md).

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer

## Setup

```bash
npm install
```

Optional runtime settings are listed in `.env.example`. The server reads environment variables from the shell or MCP client config; it does not auto-load `.env` files. Supported keys:

- `NODE_ENV`
- `LOG_LEVEL`
- `CATALUNYA_MCP_TRANSPORT`
- `CATALUNYA_MCP_MAX_RESULTS`
- `CATALUNYA_MCP_REQUEST_TIMEOUT_MS`
- `SOCRATA_APP_TOKEN`

## Run in development

```bash
npm run dev
```

The development command uses `tsx watch`, so saving TypeScript files restarts the stdio server.

## Build and run

```bash
npm run build
npm start
```

## Test and inspect

```bash
npm run typecheck
npm test
npm run smoke
npm run inspect
```

`npm run smoke` builds the server and calls its `ping` tool over stdio. `npm run inspect` opens the MCP Inspector against the built server.

## Socrata workflow

Use `socrata_search_datasets` to discover Catalunya open data datasets by text. Each result includes a `source_id`, `web_url`, and synthesized SODA `api_endpoint`.

Use `socrata_describe_dataset` with a `source_id` such as `v8i4-fa4q` to fetch the dataset schema from Socrata view metadata. The describe result includes dataset attribution, license or terms, update timestamps, the web/API URLs, and queryable columns with both display names and SODA API `field_name` values.

When query tooling is added, use the returned `field_name` values to build SODA `$select`, `$where`, and `$order` filters against the dataset `api_endpoint`.

## Lint and format

```bash
npm run lint
npm run format
```

## Claude Desktop config

After building, add a stdio server entry like this:

```json
{
  "mcpServers": {
    "catalunya-opendata-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/catalunya-opendata-mcp/dist/index.js"]
    }
  }
}
```

For local development with `tsx`:

```json
{
  "mcpServers": {
    "catalunya-opendata-mcp": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/absolute/path/to/catalunya-opendata-mcp"
    }
  }
}
```

## Current MCP surface

- Tool: `ping`
- Tool: `socrata_search_datasets`
- Tool: `socrata_describe_dataset`
- Resource: `catalunya-opendata://about`
