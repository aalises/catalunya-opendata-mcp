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
- Resource: `catalunya-opendata://about`
