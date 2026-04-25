# catalunya-opendata-mcp

MCP server for Catalonia open data.

This repository is a runnable stdio MCP server for discovering, describing, and querying Catalunya open data. The larger architecture lives in [`specs.md`](./specs.md).

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
- `CATALUNYA_MCP_RESPONSE_MAX_BYTES`
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

Use `socrata://datasets/{source_id}/metadata` when an MCP client can attach resources as context. It serializes the same inner metadata shape as `socrata_describe_dataset.data` without the tool-call envelope. The `socrata_citation` prompt provides a fill-in citation template for that metadata.

Use `socrata_query_dataset` to fetch rows from the dataset's SODA API. Call `socrata_describe_dataset` first and build raw SODA clause values with the returned `field_name` values, not display names.

Selected fields:

```json
{
  "source_id": "j8h8-vxug",
  "select": "municipi, comarca_2023, any",
  "limit": 10
}
```

Filtered query:

```json
{
  "source_id": "j8h8-vxug",
  "select": "municipi, comarca",
  "where": "comarca = 'Gironès'",
  "limit": 10
}
```

Stable pagination:

```json
{
  "source_id": "j8h8-vxug",
  "select": "municipi, comarca_2023, any",
  "order": "municipi, any",
  "limit": 25,
  "offset": 50
}
```

Aggregate query:

```json
{
  "source_id": "j8h8-vxug",
  "select": "comarca_2023, count(*) as total",
  "group": "comarca_2023",
  "order": "total desc",
  "limit": 10
}
```

Pass clause values only. Do this:

```json
{
  "source_id": "j8h8-vxug",
  "where": "municipi = 'Girona'"
}
```

Not this:

```json
{
  "source_id": "j8h8-vxug",
  "where": "?$where=municipi = 'Girona'"
}
```

When using `offset` for pagination, supply `order` so repeated calls are stable. Aggregate queries combine aggregate functions in `select` with `group`.

If Socrata rejects a query, the tool returns a structured error with the upstream response body included when available. For example, querying `j8h8-vxug` with `where: "definitely_not_a_field = 'x'"` produced this real response shape. The long SQL excerpt inside `error.message` is abridged here:

```json
{
  "data": null,
  "provenance": {
    "source": "socrata",
    "source_url": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json?%24where=definitely_not_a_field+%3D+%27x%27&%24limit=2&%24offset=0",
    "id": "analisi.transparenciacatalunya.cat:dataset_query",
    "last_updated": null,
    "license_or_terms": null,
    "language": "ca"
  },
  "error": {
    "source": "socrata",
    "code": "http_error",
    "message": "Socrata request failed with HTTP 400 Bad Request. Response body: {\"message\":\"Query coordinator error: query.soql.no-such-column; No such column: definitely_not_a_field; position: ... [abridged]\",\"errorCode\":\"query.soql.no-such-column\",\"data\":{\"column\":\"definitely_not_a_field\", ...}}",
    "retryable": false,
    "status": 400
  }
}
```

Use the `error.message` signals, especially `query.soql.no-such-column` and `No such column: definitely_not_a_field`, to return to `socrata_describe_dataset` and correct the clause with a valid `field_name`.

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
- Tool: `socrata_query_dataset`
- Prompt: `socrata_citation`
- Prompt: `socrata_query_workflow`
- Resource: `catalunya-opendata://about`
- Resource template: `socrata://datasets/{source_id}/metadata`
