# catalunya-opendata-mcp

Barebones MCP server scaffold for Catalonia open data.

This repository starts intentionally small: one runnable stdio MCP server with a `ping` tool and an `about` resource. The larger architecture lives in [`specs.md`](./specs.md).

## Requirements

- Node.js 20.10 or newer
- npm 10 or newer

## Setup

```bash
npm install
```

## Run in development

```bash
npm run dev
```

## Build and run

```bash
npm run build
npm start
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
