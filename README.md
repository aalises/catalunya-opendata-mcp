# catalunya-opendata-mcp

MCP server for Catalonia open data.

This repository is a runnable stdio MCP server for discovering, describing, and querying Catalunya open data. The larger architecture lives in [`specs.md`](./specs.md).

The first release milestone is published in the [GitHub releases](https://github.com/aalises/catalunya-opendata-mcp/releases).

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

## Socrata quick path

The Socrata adapter supports a complete search -> describe -> query workflow
against the Generalitat Catalunya open data portal. The examples below use
`j8h8-vxug`, a live housing dataset from the canary run.

### 1. Search

Use `socrata_search_datasets` to discover datasets by text. Each result includes
a `source_id`, `web_url`, and SODA `api_endpoint`.

```json
{
  "query": "Habitatges iniciats acabats",
  "limit": 10
}
```

### 2. Describe

Use `socrata_describe_dataset` to fetch schema, attribution, license or terms,
update timestamps, web/API URLs, and queryable columns. Query clauses should use
the returned `field_name` values, not display names.

```json
{
  "source_id": "j8h8-vxug"
}
```

### 3. Attach Metadata

Use `socrata://datasets/{source_id}/metadata` when an MCP client can attach
resources as context. The resource body is the same inner metadata shape as
`socrata_describe_dataset.data`, without the tool-call envelope.

```text
socrata://datasets/j8h8-vxug/metadata
```

Example metadata excerpt:

```json
{
  "source_id": "j8h8-vxug",
  "title": "Habitatges iniciats i acabats. Sèrie històrica trimestral 2000 – actualitat",
  "columns": [
    {
      "display_name": "Municipi",
      "field_name": "municipi",
      "datatype": "text"
    }
  ],
  "provenance": {
    "source_url": "https://analisi.transparenciacatalunya.cat/d/j8h8-vxug",
    "last_updated": "2025-11-10T09:43:54.000Z",
    "license_or_terms": "See Terms of Use"
  }
}
```

### 4. Query

Use `socrata_query_dataset` to fetch rows. Pass raw SODA clause values only;
never pass URL fragments such as `?$where=...`.

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
  "select": "municipi, comarca_2023, any",
  "where": "municipi = 'Girona'",
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

When using `offset`, supply `order` so repeated calls are stable. Aggregate
queries combine aggregate functions in `select` with `group`.

### 5. Recover From Query Errors

If Socrata rejects a query, the tool returns a structured error with the
upstream response body included when available.

Do this:

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

For example, querying `j8h8-vxug` with an invalid field produced this real
MCP error shape. The long SQL excerpt inside `error.message` is abridged here:

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

### 6. Cite

Use the `socrata_citation` prompt with either `socrata_describe_dataset` output
or the metadata resource. A concise citation can use `title`, `attribution`,
`source_domain`, `web_url` or `provenance.source_url`, `rows_updated_at` or
`view_last_modified`, and `license_or_terms`.

```text
Habitatges iniciats i acabats. Sèrie històrica trimestral 2000 – actualitat.
Departament de Territori, Habitatge i Transició Ecològica. Source:
analisi.transparenciacatalunya.cat. Last updated: 2025-11-10T09:43:54.000Z.
License/terms: See Terms of Use.
```

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
