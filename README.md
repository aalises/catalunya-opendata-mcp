# Catalunya Open Data MCP

A read-only Model Context Protocol server for discovering, describing, and querying public datasets from Catalunya.

The server currently focuses on the Generalitat de Catalunya open data portal powered by Socrata. It exposes a small, reliable workflow: search the catalog, inspect a dataset schema, query rows with SODA clauses, and keep enough provenance to cite the source cleanly.

## Why This Exists

Open data portals are rich, but they are not always pleasant to explore from a chat interface. This server gives MCP clients a structured way to answer questions such as:

- "Find datasets about housing starts and completions."
- "Which fields can I query in this dataset?"
- "Show the latest rows for Girona, using valid API field names."
- "Create a citation for the dataset and include the source URL."

Every data-returning tool includes provenance, response caps, and structured errors so the model can recover from bad filters instead of guessing.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer

## Install

```bash
npm install
npm run build
```

This is a local stdio MCP server. In normal use, your MCP client starts `dist/index.js` and communicates with it over stdin/stdout.

## Connect an MCP Client

After building, add a stdio server entry like this to your MCP client configuration:

```json
{
  "mcpServers": {
    "catalunya-opendata": {
      "command": "node",
      "args": ["/absolute/path/to/catalunya-opendata-mcp/dist/index.js"]
    }
  }
}
```

For active development, point the client at the TypeScript watcher instead:

```json
{
  "mcpServers": {
    "catalunya-opendata": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/absolute/path/to/catalunya-opendata-mcp"
    }
  }
}
```

The built `node dist/index.js` path is the most predictable setup for day-to-day use. The watcher is useful while changing the server.

## MCP Surface

### Tools

| Tool | Purpose |
| --- | --- |
| `ping` | Check that the server is running. |
| `socrata_search_datasets` | Search the Catalunya Socrata catalog and return dataset IDs, titles, web URLs, API endpoints, update times, and provenance. |
| `socrata_describe_dataset` | Fetch dataset metadata, license or terms, timestamps, attribution, and queryable column `field_name` values. |
| `socrata_query_dataset` | Query dataset rows with raw SODA clause values: `select`, `where`, `group`, `order`, `limit`, and `offset`. |

### Prompts

| Prompt | Purpose |
| --- | --- |
| `socrata_query_workflow` | Guides a search -> describe -> query flow and reminds clients to use returned `field_name` values. |
| `socrata_citation` | Builds a concise citation from described dataset metadata or the metadata resource. |

### Resources

| Resource | Purpose |
| --- | --- |
| `catalunya-opendata://about` | Short server metadata. |
| `socrata://datasets/{source_id}/metadata` | Dataset schema and provenance metadata, matching `socrata_describe_dataset.data`. |

## Socrata Workflow

Use the tools in this order when answering data questions.

### 1. Search

Call `socrata_search_datasets` with the user's topic:

```json
{
  "query": "Habitatges iniciats acabats",
  "limit": 10
}
```

Each result includes a `source_id`, `web_url`, `api_endpoint`, update timestamp, and provenance. Keep the `source_id` for the next step.

### 2. Describe

Call `socrata_describe_dataset` before writing filters or selecting columns:

```json
{
  "source_id": "j8h8-vxug"
}
```

Use the returned `columns[].field_name` values in SODA clauses. Do not use display names, translated labels, or column names with spaces unless they are returned as `field_name`.

### 3. Query

Pass clause values only. Do not include URL fragments such as `?$where=`.

```json
{
  "source_id": "j8h8-vxug",
  "select": "municipi, comarca_2023, any",
  "where": "municipi = 'Girona'",
  "order": "municipi, any",
  "limit": 10
}
```

For stable pagination, always include `order` when using `offset`:

```json
{
  "source_id": "j8h8-vxug",
  "select": "municipi, comarca_2023, any",
  "order": "municipi, any",
  "limit": 25,
  "offset": 50
}
```

For aggregate queries, combine aggregate functions in `select` with `group`:

```json
{
  "source_id": "j8h8-vxug",
  "select": "comarca_2023, count(*) as total",
  "group": "comarca_2023",
  "order": "total desc",
  "limit": 10
}
```

### 4. Attach Metadata

When your MCP client supports resources, attach the dataset metadata directly:

```text
socrata://datasets/j8h8-vxug/metadata
```

The resource body is the dataset metadata object itself, without the tool-call envelope. It is useful context for follow-up queries and citations.

### 5. Cite

Use `socrata_citation` with `socrata_describe_dataset` output or the metadata resource. A concise citation should include the dataset title, attribution, source domain or URL, last updated timestamp, and license or terms when available.

## Query Safety

The server is deliberately defensive:

- It is read-only.
- It validates Socrata source IDs before calling upstream APIs.
- It caps returned rows with `CATALUNYA_MCP_MAX_RESULTS`.
- It caps response size with `CATALUNYA_MCP_RESPONSE_MAX_BYTES`.
- It applies request timeouts with `CATALUNYA_MCP_REQUEST_TIMEOUT_MS`.
- It preserves upstream error details when they help the model fix a query.

If Socrata rejects a query, inspect `error.message`. For example, `query.soql.no-such-column` means the query used an invalid field. Return to `socrata_describe_dataset`, choose a valid `field_name`, and retry with a corrected clause.

## Configuration

The server reads configuration from environment variables supplied by the shell or MCP client. It does not auto-load `.env` files; `.env.example` is provided as a copyable reference.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | One of `development`, `test`, or `production`. |
| `LOG_LEVEL` | `info` | One of `trace`, `debug`, `info`, `warn`, `error`, or `silent`. Logs go to stderr so stdio transport remains clean. |
| `CATALUNYA_MCP_TRANSPORT` | `stdio` | Only `stdio` is supported in the current implementation. |
| `CATALUNYA_MCP_MAX_RESULTS` | `100` | Maximum rows/results per tool call. Hard limit: `1000`. |
| `CATALUNYA_MCP_REQUEST_TIMEOUT_MS` | `30000` | Upstream request timeout. Allowed range: `100` to `120000`. |
| `CATALUNYA_MCP_RESPONSE_MAX_BYTES` | `262144` | Maximum upstream response body size. Allowed range: `65536` to `1048576`. |
| `SOCRATA_APP_TOKEN` | unset | Optional Socrata app token for better rate-limit stability. |

Example client configuration with environment overrides:

```json
{
  "mcpServers": {
    "catalunya-opendata": {
      "command": "node",
      "args": ["/absolute/path/to/catalunya-opendata-mcp/dist/index.js"],
      "env": {
        "LOG_LEVEL": "warn",
        "CATALUNYA_MCP_MAX_RESULTS": "250",
        "SOCRATA_APP_TOKEN": "your-token"
      }
    }
  }
}
```

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the stdio server with `tsx watch`. |
| `npm run build` | Compiles TypeScript to `dist/`. |
| `npm start` | Runs the built server. |
| `npm run typecheck` | Type-checks source and tests. |
| `npm test` | Runs the Vitest suite. |
| `npm run smoke` | Builds the server and calls `ping` over stdio. |
| `npm run inspect` | Builds the server and opens the MCP Inspector against `dist/index.js`. |
| `npm run lint` | Runs Biome checks. |
| `npm run format` | Formats the repository with Biome. |
| `npm run check` | Runs typecheck, lint, tests, and smoke. |

## Project Notes

The current implementation is intentionally small: one transport, one source adapter, and a polished Socrata workflow. Broader architecture notes live in [`specs.md`](./specs.md), but the README documents what the repository does today.

## License

MIT. See [`LICENSE`](./LICENSE).
