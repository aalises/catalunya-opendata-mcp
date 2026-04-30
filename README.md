# Catalunya Open Data MCP

A read-only Model Context Protocol server for discovering, describing, and querying public datasets from Catalunya.

The server currently supports the Generalitat de Catalunya open data portal powered by Socrata, IDESCAT Tables v2, and Open Data BCN. It exposes small, reliable workflows: search or browse catalogs, inspect schemas or dimensions, query bounded extracts, run BCN geospatial scans, preview safe CSV/JSON downloads, and keep enough provenance to cite the source cleanly.

## Why This Exists

Open data portals are rich, but they are not always pleasant to explore from a chat interface. This server gives MCP clients a structured way to answer questions such as:

- "Find datasets about housing starts and completions."
- "Which fields can I query in this dataset?"
- "Show the latest rows for Girona, using valid API field names."
- "Preview Barcelona street-tree data or query DataStore-active city equipment."
- "Count tree species on Carrer Consell de Cent or find facilities near a coordinate."
- "Create a citation for the dataset and include the source URL."

Every data-returning tool includes provenance, response caps, and structured errors so the model can recover from bad filters instead of guessing.

For copy-paste task examples, see [`COOKBOOK.md`](./COOKBOOK.md).

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
| `idescat_search_tables` | Search the committed IDESCAT Tables v2 index and return table IDs plus hierarchy labels. Geography words and named places are mapped to `geo_candidates`. For exhaustive discovery, use `idescat_list_*` to browse statistics, nodes, tables, and geos directly from IDESCAT. |
| `idescat_list_statistics` | List top-level IDESCAT statistics. |
| `idescat_list_nodes` | List nodes under an IDESCAT statistic. |
| `idescat_list_tables` | List tables under an IDESCAT statistic node. |
| `idescat_list_table_geos` | List territorial divisions available for an IDESCAT table. |
| `idescat_get_table_metadata` | Fetch IDESCAT JSON-stat metadata: dimensions, category IDs, filter guidance, sources, links, and provenance. |
| `idescat_get_table_data` | Fetch a bounded flattened data extract using IDESCAT dimension/category filters and `_LAST_`. |
| `bcn_recommend_resources` | Recommend high-value Open Data BCN resources for natural-language city questions such as trees on a street, facilities near a place, or district/neighborhood area queries. |
| `bcn_plan_query` | Plan a natural-language Barcelona city question into resource, place-resolution, geo-query, and citation steps without running the final data query. |
| `bcn_execute_city_query` | Execute a ready BCN city-query plan end-to-end with the same bounded helper tools, blocking when a resource or place choice is ambiguous. |
| `bcn_answer_city_query` | Execute a ready BCN city-query plan and return deterministic `answer_text`, caveats, citation guidance, selected resource metadata, and the raw final result. |
| `bcn_search_packages` | Search Open Data BCN CKAN packages for Barcelona city datasets such as street trees, facilities, equipment, mobility, and services. |
| `bcn_get_package` | Fetch one Open Data BCN package with resource IDs, formats, DataStore activity, package license, and provenance. |
| `bcn_get_resource_info` | Inspect one Open Data BCN resource. Active DataStore resources include queryable fields. |
| `bcn_query_resource` | Query an active Open Data BCN CKAN DataStore resource with structured filters and bounded POST responses. |
| `bcn_resolve_place` | Resolve Barcelona place names to source-bounded WGS84 coordinate candidates and district/neighborhood `area_ref` metadata for follow-up geo queries. |
| `bcn_query_resource_geo` | Query BCN resources with latitude/longitude columns using `near`, `bbox`, `within_place`, street/name `contains`, and optional `group_by` counts. |
| `bcn_preview_resource` | Fetch a safe bounded CSV/JSON preview for non-DataStore Open Data BCN resources. |

### Prompts

| Prompt | Purpose |
| --- | --- |
| `socrata_query_workflow` | Guides a search -> describe -> query flow and reminds clients to use returned `field_name` values. |
| `socrata_citation` | Builds a concise citation from described dataset metadata or the metadata resource. |
| `idescat_query_workflow` | Guides an IDESCAT search/browse -> geos -> metadata -> bounded data flow. |
| `idescat_citation` | Builds a concise citation from IDESCAT table metadata. |
| `bcn_query_workflow` | Guides an Open Data BCN package -> resource -> query/preview flow. |
| `bcn_citation` | Builds a concise citation from Open Data BCN package or resource metadata. |

### Resources

| Resource | Purpose |
| --- | --- |
| `catalunya-opendata://about` | Short server metadata. |
| `socrata://datasets/{source_id}/metadata` | Dataset schema and provenance metadata, matching `socrata_describe_dataset.data`. |
| `idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata` | IDESCAT table metadata artifact, matching `idescat_get_table_metadata.data`. |
| `bcn://packages/{package_id}` | Open Data BCN package metadata, matching `bcn_get_package.data`. |
| `bcn://resources/{resource_id}/schema` | Open Data BCN resource metadata and DataStore fields, matching `bcn_get_resource_info.data`. |

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

## IDESCAT Workflow

Use `idescat_search_tables` for topic discovery, or browse with `idescat_list_statistics`, `idescat_list_nodes`, and `idescat_list_tables`. Search can recognize geography words such as `comarca`, `municipi`, `municipal`, and `provincia`, plus named places such as `Maresme`, `Barcelonès`, and `Girona`; prefer results whose `geo_candidates` include the requested geography, then confirm the `geo_id` with `idescat_list_table_geos`. It also handles common semantic aliases such as `taxa atur`, `paro`, `renda per capita Maresme`, and `poblacio municipal` without changing the tool inputs. Every metadata and data request requires a territorial division, so call `idescat_list_table_geos` before fetching a table.

IDESCAT support is scoped to Tables v2. Idescat topic pages may list inactive statistics, additional statistics, or statistics from other organisms that are not exposed through this connector.

Named-place workflow example:

```json
{
  "query": "renda per capita Maresme",
  "lang": "ca",
  "limit": 5
}
```

After choosing an RFDBC result with `com` in `geo_candidates`, call `idescat_list_table_geos` and select `geo_id: "com"`. Then pass the original place phrase into metadata:

```json
{
  "statistics_id": "rfdbc",
  "node_id": "13302",
  "table_id": "21197",
  "geo_id": "com",
  "lang": "ca",
  "place_query": "Maresme"
}
```

When `filter_guidance.recommended_data_call` is present, use it as the starting point for `idescat_get_table_data`; it contains only actual metadata category IDs and neutral defaults such as `TOTAL` or single-category dimensions.

Call `idescat_get_table_metadata` before querying. Use the returned dimension IDs and category IDs in `idescat_get_table_data.filters`, and use `last` to request the latest time periods:

```json
{
  "statistics_id": "pmh",
  "node_id": "1180",
  "table_id": "8078",
  "geo_id": "com",
  "lang": "en",
  "filters": {
    "COM": ["01", "TOTAL"],
    "SEX": "F"
  },
  "last": 2,
  "limit": 20
}
```

IDESCAT data tools are for bounded extracts, not exhaustive table export. If the upstream API returns `narrow_filters`, reduce dimensions with filters or `_LAST_`. For citations, use `idescat_get_table_metadata` or the IDESCAT metadata resource; search/list operation provenance is only an operation trace.

To manually verify the live IDESCAT journey, run `npm run canary:idescat`. It builds the server, then checks search -> geos -> metadata -> bounded data against a known PMH table using the public MCP tool surface.

## Open Data BCN Workflow

Use Open Data BCN for Barcelona city datasets such as street trees, equipment, mobility, facilities, and municipal services. For common city questions, start with `bcn_recommend_resources`; it returns likely resources, suggested tools, and example arguments. Use package search when the recommender is too narrow or the topic is not covered, then choose DataStore query, geospatial query, or download preview based on the resource metadata and the user's question.

### 1. Recommend Or Search

```json
{
  "query": "facilities in Gracia district",
  "task": "within",
  "place_kind": "district",
  "limit": 3
}
```

For open-ended discovery, search packages directly:

```json
{
  "query": "arbrat viari",
  "limit": 5
}
```

Keep the returned `package_id`, then call `bcn_get_package`:

```json
{
  "package_id": "27b3f8a7-e536-4eea-b025-ce094817b2bd"
}
```

Each resource includes `resource_id`, format, URL, and `datastore_active`.

### 2. Plan Or Execute A City Question

Use `bcn_plan_query` when the user asks a natural city question and you want an inspectable workflow:

```json
{
  "query": "tree species on Carrer Consell de Cent",
  "limit": 10
}
```

The planner returns `status`, deterministic `intent`, recommended resources, optional place-resolution candidates, ordered `steps`, `final_tool`, `final_arguments`, and citation guidance. `place_kind: "point"` maps to resolver kinds `["landmark", "facility"]`; `street`, `neighborhood`, and `district` pass through. Grouped prompts choose `group_by` deterministically: explicit input first, then neighborhood grouping for within-area questions, then the first recommended grouping field.

Use `bcn_execute_city_query` for the same input when a one-call bounded raw result is acceptable. It executes only when the plan is `ready`; otherwise it returns `execution_status: "blocked"` with the plan. For area plans, it copies `selected_candidate.area_ref` into `within_place.{source_resource_id,row_id,geometry_field}`. If no `area_ref` is available but a resolver `bbox` is available, it uses `bbox` with a caveat; if neither exists, the plan is blocked/unsupported.

Use `bcn_answer_city_query` when callers need a ready-to-display deterministic answer. It runs the same executor, then returns `answer_text`, `answer_type`, compact `summary`, deduped `caveats` such as bbox fallback, scan caps, or SQL pushdown mode, selected resource metadata, citation guidance, and the raw `final_result`.

### 3. Inspect A Resource

Call `bcn_get_resource_info` before querying:

```json
{
  "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3"
}
```

If `datastore_active` is true, the response includes queryable `fields`.

### 4. Query Active DataStore Resources

`bcn_query_resource` always uses POST JSON. Filters are structured CKAN DataStore filters, not SQL text or URL fragments:

```json
{
  "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3",
  "fields": ["_id", "Districte", "Barri"],
  "filters": {
    "Districte": "Sant Martí"
  },
  "limit": 10
}
```

The response includes `request_body` with the logical replayable request, row counts, truncation flags, and provenance.

### 5. Resolve Named Places

Use `bcn_resolve_place` when the user gives a place name instead of coordinates. The resolver is source-bounded: it queries an explicit Open Data BCN DataStore registry, ranks matching rows locally, and returns candidate WGS84 points with matched fields and source provenance. The registry covers building-address street points, administrative district and neighborhood boundaries, municipal facilities, and parks/gardens. District and neighborhood candidates include `bbox` plus `area_ref` when BCN exposes WGS84 boundary geometry; pass `area_ref` to `bcn_query_resource_geo.within_place` for "in this district/neighborhood" questions.

```json
{
  "query": "Sagrada Familia",
  "kinds": ["landmark"],
  "limit": 3
}
```

Street and area names use the same tool:

```json
{
  "query": "Plaça Catalunya",
  "kinds": ["street"],
  "limit": 3
}
```

```json
{
  "query": "Gracia",
  "kinds": ["district", "neighborhood"],
  "limit": 5
}
```

Use the best point candidate's `lat` and `lon` in `bcn_query_resource_geo.near`. For district and neighborhood candidates, prefer `within_place` when `area_ref` is present. Optional resolver `bbox` and `kinds` filters can narrow ambiguous names.

### 6. Query Resources Geospatially

Use `bcn_query_resource_geo` when the resource has WGS84 coordinate fields. It works across DataStore-active resources and safe BCN-hosted CSV/JSON downloads. DataStore resources with `near`, `bbox`, or `within_place` use generated `datastore_search_sql` internally so spatial narrowing happens upstream; callers still provide only structured inputs, never raw SQL. `within_place` first applies the resolved area's bbox upstream, then validates exact polygon containment locally. The tool infers common latitude/longitude pairs such as `latitud` / `longitud`, `geo_epgs_4326_lat` / `geo_epgs_4326_lon`, and `geo_epgs_4326_y` / `geo_epgs_4326_x`; if multiple pairs exist, pass `lat_field` and `lon_field`. It does not convert ETRS89 `x/y` fields.

Street or name matching uses `contains`:

```json
{
  "resource_id": "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
  "contains": {
    "adreca": "Carrer Consell de Cent"
  },
  "group_by": "cat_nom_catala",
  "fields": ["adreca", "cat_nom_catala"],
  "limit": 10
}
```

Nearby queries use explicit coordinates:

```json
{
  "resource_id": "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
  "near": {
    "lat": 41.4036,
    "lon": 2.1744,
    "radius_m": 750
  },
  "fields": ["name", "addresses_road_name", "addresses_neighborhood_name"],
  "limit": 10
}
```

Area queries use `area_ref` from `bcn_resolve_place`:

```json
{
  "resource_id": "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
  "within_place": {
    "source_resource_id": "576bc645-9481-4bc4-b8bf-f5972c20df3f",
    "row_id": 6,
    "geometry_field": "geometria_wgs84"
  },
  "fields": ["name", "addresses_neighborhood_name", "addresses_district_name"],
  "group_by": "addresses_neighborhood_name",
  "limit": 10
}
```

The response includes `strategy`, `datastore_mode` (`sql` or `scan`) for DataStore resources, `coordinate_fields`, `_geo` coordinates with optional `distance_m`, scan counts, match counts, truncation flags, `upstream_total` for fully upstream-filtered DataStore resources, and `groups` when `group_by` is provided. When a DataStore SQL query still needs local `within_place` polygon filtering, `upstream_bbox_total` reports the bbox-matching upstream count before exact polygon containment. When local `contains` filtering is applied after SQL pushdown, `upstream_prefilter_total` reports the upstream count before the local text filter. When `within_place` and `contains` are combined, both fields are present and report the same pre-local-filter count (i.e., bbox-matching rows that also satisfy the SQL `WHERE` clause). The `logical_request_body.sql` in provenance reflects the caller's logical query (using their `limit`/`offset`); the runtime issues paginated upstream calls behind it whenever local post-filtering is needed, so replaying the logical SQL verbatim returns bbox-matching rows, not the post-filtered slice. Group rows include `count`, `sample`, and for `near` queries `min_distance_m` plus `sample_nearest`.

Geo helpers remain bounded. DataStore `near`, `bbox`, and `within_place` queries push spatial predicates into CKAN SQL, while DataStore calls without spatial inputs and download resources still scan locally. When `truncation_reason` is `scan_cap`, additional matches may exist beyond the scanned rows; narrow `bbox`, `contains`, or `filters`, or raise `CATALUNYA_MCP_BCN_GEO_SCAN_MAX_ROWS` for local trusted runs. Download JSON resources are accepted only when small enough to parse as complete documents; larger JSON resources should use a DataStore or CSV sibling.

### 7. Preview Inactive CSV/JSON Resources

If `datastore_active` is false, use `bcn_preview_resource` for a bounded sample:

```json
{
  "resource_id": "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
  "limit": 5
}
```

Preview is intentionally not an export tool. It only follows HTTPS URLs hosted by `opendata-ajuntament.barcelona.cat`, validates every redirect, reads at most `CATALUNYA_MCP_BCN_UPSTREAM_READ_BYTES + 1`, and parses CSV/JSON into capped rows.

## Query Safety

The server is deliberately defensive:

- It is read-only.
- It validates Socrata source IDs before calling upstream APIs.
- It caps returned rows with `CATALUNYA_MCP_MAX_RESULTS`.
- It caps response size with `CATALUNYA_MCP_RESPONSE_MAX_BYTES`.
- It applies request timeouts with `CATALUNYA_MCP_REQUEST_TIMEOUT_MS`.
- It preserves upstream error details when they help the model fix a query.
- It maps IDESCAT cell-limit errors to `narrow_filters` with the original JSON-stat error in `source_error`.
- It restricts Open Data BCN previews to allowlisted HTTPS BCN download hosts and caps upstream preview bytes.
- It reuses the same BCN download allowlist for geospatial CSV/JSON scans and caps scanned bytes and rows.

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
| `CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES` | `8388608` | Maximum IDESCAT upstream success body to read before flattening/capping. Allowed range: `65536` to `33554432`. |
| `CATALUNYA_MCP_BCN_UPSTREAM_READ_BYTES` | `2097152` | Maximum Open Data BCN download preview body to read before parsing/capping. Allowed range: `65536` to `16777216`. |
| `CATALUNYA_MCP_BCN_GEO_SCAN_MAX_ROWS` | `50000` | Maximum Open Data BCN rows to scan for geospatial helper calls. Allowed range: `1000` to `100000`. |
| `CATALUNYA_MCP_BCN_GEO_SCAN_BYTES` | `67108864` | Maximum Open Data BCN CSV/JSON download body to read for one geospatial helper call. Allowed range: `2097152` to `134217728`. |
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
| `npm run smoke` | Builds the server and checks core tool/prompt/resource registration over stdio, then calls `ping`. |
| `npm run canary:socrata` | Builds the server and runs the live Socrata search -> describe -> query canary. |
| `npm run canary:idescat` | Builds the server and runs the live IDESCAT search -> geos -> metadata -> data canary. |
| `npm run eval:canary` | Builds the server and runs the live binary MCP evaluation canary. |
| `npm run eval:stress` | Builds the server and runs the full live binary MCP evaluation suite. |
| `npm run eval:replay:canary` | Replays the canary evaluation from the committed MCP cassette. |
| `npm run eval:replay:stress` | Replays the full evaluation suite from the committed MCP cassette. |
| `npm run package:size` | Checks packed/unpacked package size and total generated IDESCAT index size. |
| `npm run inspect` | Builds the server and opens the MCP Inspector against `dist/index.js`. |
| `npm run refresh:idescat` | Crawl IDESCAT Tables v2 and regenerate the committed search index. |
| `npm run lint` | Runs Biome checks. |
| `npm run format` | Formats the repository with Biome. |
| `npm run check` | Runs typecheck, lint, tests, smoke, and package size checks. |

## Evaluations

The repository includes live MCP evaluations for checking how well the server performs as an actual MCP adapter, not just as local TypeScript modules. The evaluator builds the project, starts `node dist/index.js` over stdio, calls the public MCP surface, and grades each tool, prompt, and resource response with a deterministic pass/fail assertion.

Use replay mode for deterministic local or CI checks that should not depend on live upstream availability:

```bash
npm run eval:replay:canary
npm run eval:replay:stress
```

Replay mode reads committed cassettes from `tests/fixtures/evals/`. It exercises the same evaluation logic and report schema, but returns previously captured MCP responses instead of calling Socrata or IDESCAT.

Use live mode while checking current upstream behavior:

```bash
npm run eval:canary
npm run eval:stress
```

Refresh cassettes after intentionally changing adapter behavior or accepting upstream drift:

```bash
npm run eval:record:canary
npm run eval:record:stress
```

The stress profile currently runs 149 live cases:

| Connector | Cases |
| --- | ---: |
| MCP surface | 1 |
| Socrata | 53 |
| Open Data BCN | 24 |
| IDESCAT | 71 |

The cases cover discovery, metadata, bounded data queries, safe BCN CSV preview, BCN resource recommendations, BCN place resolution for landmarks, streets, neighborhoods, and districts, BCN city-query planning/execution/answering, BCN area-aware geospatial queries, prompts, metadata resources, pagination, invalid inputs, upstream errors, local cap behavior, low-response-cap degradation, and the IDESCAT long-filter regression. In particular, the IDESCAT regression verifies long multi-value filters stay in a canonical GET URL, return `request_method: "GET"`, omit request body params, and preserve the expected selected cell count.

Every run writes a machine-readable JSON report under `tmp/`, for example `tmp/mcp-eval-stress-<timestamp>.json`. The report includes each case id, inputs, binary score, failure reason, sub-assertions with expected and actual values, duration, compact result summary, connector totals, and expected-count checks. A run fails if any case fails or if the expected MCP/Socrata/IDESCAT case counts drift.

Live evals are intentionally separate from `npm run check` because they call Generalitat and IDESCAT services. If an upstream service is down or rate-limited, a live eval can fail even when local unit tests and replay evals are healthy. For more detail on the evaluation design, cassette modes, and report format, see [`docs/evaluations.md`](./docs/evaluations.md).

## Release Checklist

Before opening or merging routine changes, run `npm run check`. This stays local and does not include live upstream canaries.

For release readiness or adapter changes, optionally run `npm run canary:socrata`, `npm run canary:idescat`, and `npm run eval:stress`. These commands exercise the public MCP surface against live Generalitat/IDESCAT/Open Data BCN services, so they are intentionally manual and may fail when an upstream service is unavailable. The evaluation harness writes a JSON report with binary case scores and connector-level summaries; see [`docs/evaluations.md`](./docs/evaluations.md). User-facing release notes live in [`docs/release-notes.md`](./docs/release-notes.md).

## Project Notes

The current implementation is intentionally small: one transport and three source adapters (Socrata catalog/query, IDESCAT Tables v2 browse/metadata/data, and Open Data BCN catalog/query/place/geo workflows). The IDESCAT search index ships as committed generated source; refresh it manually with `npm run refresh:idescat` when the upstream catalog changes. Broader architecture notes live in [`specs.md`](./specs.md), but the README documents what the repository does today.

## License

MIT. See [`LICENSE`](./LICENSE).
