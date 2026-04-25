# Plan: catalunya-opendata-mcp

An MCP server exposing Catalan open data from three sources:

- **Dades Obertes de Catalunya** (Socrata) — `analisi.transparenciacatalunya.cat`
- **IDESCAT** — Institut d'Estadística de Catalunya, via the **Taules v2** API
- **Open Data BCN** (CKAN) — `opendata-ajuntament.barcelona.cat`

Adding BCN (CKAN) to v1 — it's what powers the flagship `arbrat viari` tree demo, and three Catalan sources is a stronger product pitch than two.

## Scope decisions

- **Runtime**: TypeScript + production `@modelcontextprotocol/sdk` v1.x, pinned to a patched release range. Track SDK v2, but do not build on it until it is stable. Installable via `npx`.
- **Architectural center**: sources are bounded contexts; MCP is an adapter over them. The Socrata, IDESCAT, and BCN integrations share contracts for provenance, errors, caps, caching, and search references, but never share query-builder internals.
- **Transport**: transport-agnostic core. Ship stdio and Streamable HTTP from the same server factory, with stdio powering local/MCPB installs and HTTP powering public use. CLI flag `--transport stdio|http` selects mode for self-hosting.
- **Distribution**:
  - v1 alpha: npm package for local (`npx`) + **MCPB / Claude Desktop Extension**. Both are stdio.
  - v1 public: Docker image + hosted Streamable HTTP endpoint. This is required for ChatGPT/OpenAI API, multi-client demos, and a `datagouv-mcp`-style product story.
- **Three adapters, one server**: Socrata (SoQL), IDESCAT (Taules v2 / JSON-stat), BCN (CKAN DataStore). Shared tool-surface conventions, separate clients.
- **Audience**: curated source-native tools + advanced raw-query escape hatches (`socrata.run_soql`, `bcn.run_ckan_sql`) behind stricter guards.
- **Caching**:
  - Local stdio: in-memory LRU, 5 min TTL for metadata
  - Hosted HTTP: in-memory LRU is **opportunistic only** (per-instance, wiped on restart/deploy). A shared cache layer (KV/Redis) is out of v1 scope.
- **Observability**: structured logging everywhere, Sentry on hosted deployments only.
- **License**: MIT, public repo.
- **Provenance is mandatory**: every tool response includes `source`, `source_url`, `id`, `last_updated`, `license_or_terms`, `language`. Required by IDESCAT terms of use and just-good-design for Socrata/CKAN.

## Architectural principles

1. **Source isolation over clever unification** — every upstream has its own adapter, query model, metadata model, canaries, and typed errors. Shared code lives only below the "source adapter" interface or above it in MCP orchestration.
2. **MCP-native outputs** — every tool returns `structuredContent` that conforms to an `outputSchema`, plus a compact JSON text fallback for older clients. The provenance envelope is part of the structured schema, not an informal convention.
3. **Small tools, rich workflow hints** — tools do one upstream action well. Tool descriptions encode safe workflows (`search -> metadata/schema -> query`) and next-step hints; prompts provide curated user-facing workflows.
4. **Resources for durable context** — metadata, schemas, and selected catalog entries are exposed as MCP resources/resource templates so clients can attach context without re-running broad tools.
5. **Compatibility without contaminating the domain** — thin `search` and `fetch` tools exist for clients that expect generic retrieval. They return typed references and dispatch to source-specific adapters; they do not dedupe or flatten source semantics.
6. **Defensive by default** — read-only tools, explicit caps, validated query ASTs where possible, parser-gated raw SQL/SoQL escape hatches, timeouts, rate limits, and no secrets in tool results.
7. **Canary-driven confidence** — each source has pinned live assets used in contract tests, demo screenshots, and regression prompts. A source is not "implemented" until canaries pass end-to-end through stdio and HTTP.

## Architecture

```
src/
  index.ts                  # CLI entry
  config.ts                 # env + runtime config, no source logic
  mcp/
    server.ts               # server factory, capability registration
    tools/                  # MCP tool registration only
      compatibility.ts      # search/fetch bridge for retrieval clients
      socrata.ts
      idescat.ts
      bcn.ts
      geo.ts
    resources/              # metadata/schema resource templates
      catalog.ts
      schemas.ts
    prompts/                # user-triggered workflows
      explore.ts
      compare.ts
      map.ts
    schemas/                # input/output JSON schemas generated from Zod
    result.ts               # structuredContent + text fallback helpers
  transports/
    stdio.ts                # v1
    http.ts                 # v1 public
  sources/
    common/
      source-adapter.ts     # SourceAdapter contract
      search-reference.ts   # socrata:..., idescat:..., bcn:...
      provenance.ts
      errors.ts
      caps.ts
      pagination.ts
    socrata/
      adapter.ts            # implements SourceAdapter
      catalog.ts            # reads portal data.json (DCAT)
      client.ts             # v3 /query + legacy fallback
      soql-builder.ts
      geo.ts
      types.ts
    idescat/
      adapter.ts            # implements SourceAdapter
      client.ts             # Taules v2 (taules/v2)
      json-stat.ts          # JSON-stat → row-oriented flattener
      index.ts              # packaged + refreshable table search index
      types.ts
    bcn/
      adapter.ts            # implements SourceAdapter
      client.ts             # CKAN action API + DataStore
      sql-guard.ts          # SELECT-only parser / LIMIT enforcement
      geo.ts
      types.ts
  services/
    geography/
      resolver.ts           # municipi/comarca/provincia codes + labels
    search/
      router.ts             # compatibility search/fetch dispatcher
    cache/
      memory.ts             # in-memory LRU
      disk.ts               # optional local metadata/index cache
    telemetry/
      logger.ts             # structured, LOG_LEVEL env
      sentry.ts             # no-op unless SENTRY_DSN set
tests/
  sources/                  # unit tests with nock/fixtures
  mcp/                      # schema + tool-result contract tests
  contract/                 # recorded fixtures against real APIs
  e2e/                      # stdio + HTTP smoke tests
packaging/
  mcpb/                     # manifest.json, icon, screenshots
  registry/                 # server.json for MCP Registry
Dockerfile
docker-compose.yml
```

## MCP result contract (applies to every tool)

Every tool returns:

- `structuredContent`: the canonical machine-readable result.
- `content[0].text`: compact JSON string fallback for clients that do not yet consume structured output well.
- `outputSchema`: registered per tool, with a shared provenance/error fragment.

```ts
{
  content: [
    {
      type: "text",
      text: JSON.stringify(structuredContent)
    }
  ],
  structuredContent: {
    data: <tool-specific>,
    provenance: {
      source: "socrata" | "idescat" | "bcn",
      source_url: string,
      id: string,
      last_updated?: string,      // ISO 8601
      license_or_terms: string,
      language: "ca" | "es" | "en"
    },
    next_suggested_tools?: string[],
    source_error?: unknown        // upstream error preserved verbatim when useful
  },
  isError?: boolean
}
```

For tool-execution failures caused by upstream APIs, bad filters, exceeded caps, or unavailable DataStore resources, return `isError: true` with actionable structured detail. Reserve protocol-level JSON-RPC errors for malformed MCP requests, unknown tools, or server failures the model cannot self-correct.

Pagination shape is **per-tool**, not universal — Socrata datasets, CKAN records, and IDESCAT tables paginate very differently. See each tool below.

## Response caps (all data-returning tools)

Every tool that returns upstream data applies hard limits **server-side**, regardless of what the upstream allows, to keep MCP responses reliable:

| Cap | Default | Hard max |
|---|---|---|
| Rows returned per call | 500 | 1000 |
| Response payload size | 256 KB | 1 MB |
| Upstream request timeout | 20 s | 30 s |

Applies to `socrata.query_dataset`, `socrata.run_soql`, `socrata.query_dataset_geo`, `idescat.get_table_data`, `bcn.query_resource`, `bcn.query_resource_geo`, `bcn.run_ckan_sql`. When any cap is hit, the response includes:

```ts
{
  data: <partial>,
  meta: {
    truncated: true,
    truncation_reason: "row_cap" | "byte_cap" | "timeout",
    hint: "narrow filters / reduce select / paginate"
  }
}
```

Callers can raise defaults (up to hard max) via tool params; the model is told in the tool description to prefer narrowing over raising limits.

## Source adapter contract

Every source adapter implements the same outer contract, while keeping source-specific query mechanics private:

```ts
interface SourceAdapter {
  readonly source: "socrata" | "idescat" | "bcn";
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
  fetch(ref: SearchReference, options: FetchOptions): Promise<FetchedResource>;
  getCapabilities(): SourceCapabilities;
  health(): Promise<SourceHealth>; // shallow, no broad upstream probes
}
```

Adapters may expose richer source-native methods (`queryDataset`, `getTableData`, `queryResource`) to the MCP tool layer. Cross-source services can depend only on `SourceAdapter`, `SearchReference`, provenance, normalized errors, and caps.

## Tools exposed

Tool names are dot-namespaced by source for clarity and client-side action controls:

- `socrata.*`
- `idescat.*`
- `bcn.*`
- `geo.*`
- compatibility-only: `search`, `fetch`

### Socrata (Dades Obertes)

Catalog sourced from the portal's DCAT `data.json` for listing/licenses/distributions. Data queries go through Socrata v3 `/api/v3/views/{id}/query.json` **where proven available on `analisi.transparenciacatalunya.cat`** — v3 availability is a contract-test gate, not a settled assumption. Where v3 is missing on a given dataset, fall back to legacy SODA 2.1 / `rows.json`.

- `socrata.search_datasets(query, page?, page_size?)` — catalog search against `data.json`. Returns dataset list with licenses + distributions. *Next: `socrata.get_dataset_metadata`.*
- `socrata.get_dataset_metadata(datasetId)` — columns, updated_at, publisher, themes, license. *Next: `socrata.list_dataset_resources` or `socrata.query_dataset`.*
- `socrata.list_dataset_resources(datasetId)` — lists all DCAT distributions (CSV, JSON, RDF, XML, HTML landing pages, PDFs, non-Socrata upstream links). Supersedes the original "attachments" concept — DCAT distributions cover more ground. Returns `{ title, format, media_type, url, description? }[]`.
- `socrata.get_dataset_stats(datasetId)` — **best-effort**. Returns only fields verified against `analisi.transparenciacatalunya.cat`: `{ row_count, updated_at, created_at }`. `page_views`/`downloads` only if confirmed stable; otherwise omitted.
- `socrata.query_dataset(datasetId, where?, select?, group?, order?, page?)` — structured SoQL. Uses v3's `page` object where available (`{ pageNumber, pageSize }`), falls back to `limit`/`offset` on legacy endpoints. **`order` required for stable paginated reads** — but only injected (default `:id`) when the query is a plain row select. If `group` or an aggregate function in `select` is present, no default order is injected (injecting one breaks aggregate queries). Row cap per endpoint: 50k on SODA 2.0, unlimited on 2.1/3.0.
- `socrata.run_soql(datasetId, soql)` — **advanced**, marked as such in the tool description. Hallucinated column names are a common failure mode; the description explicitly tells the model to call `socrata.get_dataset_metadata` first. Enforce dataset scoping, max query length, no multi-statements, and response caps.
- `socrata.query_dataset_geo(datasetId, bbox? | near?, where?, limit?)` — geospatial helper for 2.1+/3.0 datasets: bbox or point-radius queries, returns GeoJSON. Required for map/tree/air-quality demos to work without the LLM hand-writing SoQL `within_box`.

### IDESCAT (Taules v2)

Modeled against the actual `taules/v2` surface, not `indicadors/v1` (which only exposes `dades` + `nodes` and is narrower than originally planned). `indicadors/v1` may be added later as a read-only "indicators of the day" tool if useful; it doesn't replace the general-purpose surface.

Taules v2 URL shape is `/{statistics}/{node}/{table}/{geo}` for metadata and `/{statistics}/{node}/{table}/{geo}/data` for data. Every data-fetch tool takes a `geoId` — there is no such thing as a table query without a territorial division.

JSON-stat responses are flattened to row-oriented data (label + value + dimension-values) before returning to the LLM. Raw JSON-stat is token-inefficient.

- `idescat.search_tables(query, lang?, limit?)` — free-text search over the full IDESCAT catalog (statistics + nodes + tables, matching titles and descriptions). Returns `{ statisticsId, nodeId, tableId, title, path }[]`. Taules v2 has no native search endpoint, so v1 ships with a generated search index and refreshes it opportunistically (disk cache locally, memory/shared cache when hosted). Required entry point for prompts like "baby names" or "unemployment by comarca" — hierarchical traversal alone doesn't let the LLM find the right table.
- `idescat.list_statistics(lang?)` — top-level catalog of statistics.
- `idescat.list_nodes(statisticsId, lang?)` — nodes within a statistic.
- `idescat.list_tables(statisticsId, nodeId, lang?)` — tables within a node. *Next: `idescat.list_table_geos`.*
- `idescat.list_table_geos(statisticsId, nodeId, tableId)` — territorial divisions supported (municipi/comarca/provincia/Catalunya/etc.). *Next: `idescat.get_table_metadata`.*
- `idescat.get_table_metadata(statisticsId, nodeId, tableId, geoId, lang?)` — dimensions, units, periodicity for this table+geo combo.
- `idescat.get_table_data(statisticsId, nodeId, tableId, geoId, filters?, lang?)` — fetch flattened data.

**Error handling**: Taules v2 returns JSON-stat `{ class: "error", status, id, label }` on failure. Cell-limit overflow is HTTP 416 with internal code `05`. Both are surfaced as a typed `NarrowFiltersError` carrying the original `status`/`id`/`label` in `source_error` so the LLM sees actionable detail.

**Safe-narrowing flow** (embedded in tool descriptions): `idescat.search_tables` (or `idescat.list_statistics → idescat.list_nodes → idescat.list_tables`) `→ idescat.list_table_geos → idescat.get_table_metadata → idescat.get_table_data with filters`. `idescat.search_tables` is the expected entry point; hierarchical traversal is an escape hatch. No fake pagination.

### Open Data BCN (CKAN)

Two distinct base paths, modeled as separate client surfaces:

- **CKAN Action API** at `/data/api/3/action/*` for catalog: `package_search`, `package_show`, `resource_show`.
- **DataStore API** at `/data/api/action/datastore_search` and `/data/api/action/datastore_search_sql` for row queries.

Tools:

- `bcn.search_packages(query, page?, page_size?)` — `package_search`.
- `bcn.get_package(packageId)` — `package_show`, returns metadata + resources.
- `bcn.get_resource_info(resourceId)` — `resource_show`, includes `datastore_active` flag. When active, also returns **field schema** (`{ id, type }[]`) fetched via `datastore_search?resource_id=X&limit=0`, so the LLM knows valid column names + types before building filters or SQL. Without this, `bcn.query_resource` and `bcn.run_ckan_sql` are blind.
- `bcn.query_resource(resourceId, filters?, q?, limit?, offset?, fields?, sort?)` — `datastore_search`. Only works when `datastore_active` is true; returns a typed `DataStoreUnavailableError` otherwise. Tool description tells the LLM to call `bcn.get_resource_info` first for schema.
- `bcn.query_resource_geo(resourceId, bbox? | near?, latField?, lonField?, filters?, limit?)` — geospatial helper for DataStore resources with coordinate columns. It infers common latitude/longitude field names from schema and asks for explicit fields when ambiguous. Required for the `arbrat viari` demo.
- `bcn.run_ckan_sql(sql)` — **advanced**, raw `datastore_search_sql`. SELECT-only, parser-gated, max query length, no multi-statements, forced `LIMIT`, response caps, and explicit warning that SQL search may be disabled by the portal.

### Unified

No "smart unified search" in v1. Cross-source dedupe by title similarity hides the fact that Socrata datasets, IDESCAT tables, and CKAN packages are different object types with different follow-up tools. Better to let the LLM call the three per-source search tools explicitly.

However, v1 includes a **thin MCP compatibility retrieval layer**:

- `search(query, source?, limit?)` — fan-out to source adapters and return typed references with no dedupe, e.g. `{ id: "idescat:pmh/1180/8078/com", title, url, source, object_type }`.
- `fetch(id, lang?)` — resolve a typed reference into a compact, citation-ready document with provenance and suggested source-native tools.

This exists for clients and workflows that expect generic retrieval (`search`/`fetch`) while preserving the source-native tools as the real product surface.

## Resources

Expose durable metadata and schemas as resources/resource templates:

- `socrata://datasets/{datasetId}/metadata`
- `socrata://datasets/{datasetId}/resources`
- `idescat://tables/{statisticsId}/{nodeId}/{tableId}/{geoId}/metadata`
- `bcn://packages/{packageId}`
- `bcn://resources/{resourceId}/schema`

Resource reads return compact JSON plus provenance annotations and `lastModified` when available. Tools may return `resource_link` blocks for follow-up context, especially after search and metadata calls.

## Prompts

Prompts are user-controlled workflows, not hidden instructions:

- `explore_dataset` — find a dataset/table, inspect schema, preview rows, explain provenance.
- `compare_places` — normalize Catalan places, choose source-specific geography codes, compare values.
- `map_open_data` — use Socrata/BCN geo helpers to produce GeoJSON-ready results.
- `build_citation` — turn a tool result into a user-facing citation with source URL, terms, and update date.

## Geography helper

- `geo.normalize_catalan_place(name)` — resolve free-text place names ("Girona", "Vallès Oriental", "L'Hospitalet") to canonical codes for each source. Socrata and CKAN expect different code systems; IDESCAT uses its own. Prevents cross-source queries from failing on naming drift.

## Implementation phases

1. **Scaffold** — repo, tsconfig, patched MCP SDK v1.x, vitest + nock/MSW, biome, CI, release scripts.
2. **Core contracts** — `SourceAdapter`, `SearchReference`, provenance fragment, normalized errors, caps, pagination helpers, structured result helpers.
3. **Canary discovery** — manually pin Socrata, IDESCAT, and BCN assets before deep implementation. Lock canaries into fixtures, README examples, and smoke prompts.
4. **Socrata source** — DCAT catalog reader, v3 `/query` client + legacy fallback, SoQL builder, geospatial helper, pagination with stable ordering.
5. **IDESCAT source** — Taules v2 client, generated search index, JSON-stat flattener, HTTP 416 → `NarrowFiltersError`.
6. **BCN source** — CKAN action + DataStore client, schema introspection, SELECT-only SQL guard, DataStore geo helper.
7. **Geography service** — seed code/label tables for municipi/comarca/provincia; resolver with source-specific output codes.
8. **MCP tools** — dot-namespaced Zod schemas, output schemas, descriptive workflow hints, advanced raw-query tools gated and clearly labeled.
9. **MCP resources + prompts** — resource templates for metadata/schema context; curated prompts for exploration/comparison/map/citation workflows.
10. **Compatibility search/fetch** — typed-reference fan-out and resolver, kept separate from source-native tools.
11. **Provenance + observability** — structured result contract, `source_error` passthrough, structured logger (`LOG_LEVEL`), Sentry no-op-unless-DSN.
12. **Caching** — in-memory LRU for hot metadata, generated IDESCAT index, optional local disk cache, documented as opportunistic on hosted unless a shared cache is configured.
13. **Transports** — stdio and Streamable HTTP from the same server factory. HTTP includes `/mcp`, `/live`, `/ready`, origin/host validation, rate limits, concurrency caps, timeout budgets.
14. **Packaging** — npm package, MCPB bundle, Docker image, MCP Registry `server.json`, README install snippets for Claude Desktop, Claude Code, VS Code/Cursor, ChatGPT/OpenAI API, and generic HTTP clients.
15. **Verification** — recorded contract tests, stdio e2e, HTTP e2e, MCP Inspector scripts, schema snapshot tests, and smoke prompts for every canary.
16. **Docs** — README with:
    - stdio `claude_desktop_config.json` snippet
    - MCPB / Desktop Extension install instructions
    - hosted Streamable HTTP config
    - MCP Inspector debugging section
    - Provenance / licensing explainer
    - 8–10 example prompts with screenshots
17. **Publish v1 alpha** — npm + MCPB for desktop users and local developer feedback.
18. **Publish v1 public** — hosted HTTP + Docker image + registry listings. Deploy to **Fly.io** or another Node-native host. Sentry enabled via `SENTRY_DSN`. Abuse controls: rate limit per IP, concurrency cap, request timeouts, explicit anonymous-use policy.

## Key technical considerations

- **Socrata app token**: improves rate-limit stability. Socrata docs describe token requests as *currently unthrottled unless abusive* — not a guaranteed numeric quota. Surface via `SOCRATA_APP_TOKEN`.
- **Socrata pagination**: stable pagination is required. `socrata.query_dataset` uses v3 `page` ordering when available; legacy fallback enforces an explicit `$order` for row selects. If the caller omits it, inject `:id` only when doing a plain row select.
- **Socrata endpoint version**: primary path is SODA 2.1 / v3 `/query`; fallback to legacy `rows.json` when v3 unavailable on a given dataset.
- **IDESCAT attribution**: required by terms — encoded into the structured provenance fragment so the model can cite correctly.
- **IDESCAT 20k cell cap**: exposed as a typed `NarrowFiltersError` telling the LLM to constrain dimensions further.
- **Raw SQL/SoQL**: advanced tools are allowed, but guarded. `socrata.run_soql` is dataset-scoped; `bcn.run_ckan_sql` is SELECT-only, parser-gated, single-statement, and forced through server-side caps.
- **Response size**: trim verbose metadata; flatten JSON-stat; return only fields the LLM will use.
- **Language**: all three sources support ca/es/en to varying degrees. Default `ca`, expose as param on every tool.
- **Tests**: source unit tests + recorded-fixture contract tests per adapter + schema snapshot tests + stdio/HTTP transport smoke tests.
- **Caching limits**: in-memory LRU is per-process. On hosted, treat as opportunistic; persistent/shared cache is a phase-3 decision.
- **Error handling**: normalized `ServerError` class wraps upstream errors; `source_error` field preserves the original payload so the LLM can show actionable details.
- **Health**: `/live` shallow only (process up). `/ready` checks internal state. No live upstream calls in either.
- **HTTP transport security**: validate `Origin` and `Host`, bind localhost for local HTTP development, never expose unauthenticated local HTTP on all interfaces, and document OAuth/auth choices before public hosted launch.
- **Hosted abuse controls**: rate limit (per IP), concurrency cap, 30s request timeout, 429 on excess. Anonymous use allowed in v1 public only if monitored and cheap enough.

## Architecture quality gates

Before calling v1 complete:

- A new source can be added by implementing `SourceAdapter` plus source-native tools, without editing Socrata/IDESCAT/BCN internals.
- Every data-returning tool has input schema, output schema, structured result, text fallback, provenance, caps, and a contract test.
- Every source has at least one live canary and one fixture-backed failure path.
- `search`/`fetch` use typed references and do not import source-specific query builders.
- MCP resources expose metadata/schema context without broad data retrieval.
- Advanced raw-query tools are disabled by policy flag in hosted deployments if abuse or cost becomes a problem.
- The public README explains the security model: read-only, upstream public data only, no user secrets returned, no write actions.

## Canary assets

Pinned IDs used for contract tests, demo recordings, README screenshots, and prompt validation. Every source needs at least one confirmed canary before v1 ships. Chosen during canary discovery after manual portal exploration:

- **Socrata canary** (`analisi.transparenciacatalunya.cat`): TBD — one dataset with confirmed v3 `/query` availability and stable identifier. Candidates: air-quality readings, road-accident data, hospital waiting lists.
- **IDESCAT canary** (Taules v2): TBD — one full `{statistics, node, table, geo}` tuple. Candidates: population by comarca, baby-name frequency by year, unemployment rate.
- **BCN canary** (CKAN DataStore): `arbrat-viari` (street trees) with a known `datastore_active` resource ID — required for the marquee Consell de Cent demo.

Canary IDs are hard-coded in `tests/contract/` fixtures and referenced in the README example gallery so screenshots are reproducible.

## Example prompts to validate

- "What's the air quality in Barcelona today?" → Socrata dataset query
- "Population of Girona by year since 2010" → IDESCAT Taules v2
- "Find datasets about electric vehicle charging stations" → Socrata + BCN search
- "Unemployment rate by comarca, latest year" → IDESCAT Taules v2 with geography filter
- "Tree species on Carrer Consell de Cent" → BCN `arbrat viari` via CKAN DataStore + geospatial filter
- "Most popular baby names in Catalonia over the last decade" → IDESCAT Taules v2

## Config examples

### Local (stdio via npx)

```json
{
  "mcpServers": {
    "catalunya-opendata": {
      "command": "npx",
      "args": ["-y", "catalunya-opendata-mcp"],
      "env": {
        "SOCRATA_APP_TOKEN": "recommended"
      }
    }
  }
}
```

### MCPB / Claude Desktop Extension

One-click install from an `.mcpb` artifact. Bundle `manifest.json`, icon, screenshots, declared tools/prompts, and optional `SOCRATA_APP_TOKEN` user config. Submit to the Desktop Extensions directory after alpha validation.

### Hosted (Streamable HTTP) — v1 public

```json
{
  "mcpServers": {
    "catalunya-opendata": {
      "url": "https://catalunya-opendata-mcp.<domain>/mcp"
    }
  }
}
```

Docker (`docker compose up -d`) ships with the public HTTP distribution.

## Go-to-market

### Assets to prepare first (highest leverage)

- **60–90 sec demo video** — open Claude, run two prompts that render well on camera:
  1. *"Show me the most popular baby names in Catalonia over the last decade"* — IDESCAT Taules v2 time series, charts beautifully.
  2. *"What tree species line Carrer Consell de Cent?"* — BCN `arbrat viari` via CKAN + geospatial filter. Very visual, very Catalan, and now actually in scope.
- **README example gallery** — 8–10 prompts with screenshots, provenance visible in each answer.
- **Build blog post** — *"I built an MCP server for Catalan open data — here's what three portals look like through an LLM."* Post to dev.to + Spanish tech pub (paradigma, genbeta) + personal site.

### MCP directories (1 evening of PRs)

- **MCP Registry** — the official published-server list. `modelcontextprotocol/servers` is a **reference-implementations** repo, not a directory; don't treat it as one.
- `mcp.so`, `smithery.ai`, `glama.ai` — community aggregators.
- `punkpeye/awesome-mcp-servers` — main "awesome" list.
- **Claude Desktop Extensions directory** — highest-leverage install path for end users.

### Open data community (the real audience)

- **Generalitat `dades.gencat.cat`** — contact form; they feature community tools on the blog. Lead with attribution/uptime, not stars.
- **IDESCAT** — small responsive team, cold email works. Attribution + bilingual docs matter to them.
- **Open Data BCN** team + mailing list.
- **data.europa.eu** — EU-level cross-listing.

### Catalan/Spanish tech communities

- **BarcelonaJS**, **Barcelona.rb**, **Python Barcelona** meetups — 10-min lightning talks.
- **Canòdrom** (Ateneu d'Innovació Digital) — civic-tech events.
- **Twitter/Bluesky** — tag `@gencat`, `@idescat`, `@bcn_ajuntament`, `@dadesObertesCat`. Spanish-language post separate from English.
- **Reddit** — `r/catalunya` (civic angle), `r/LocalLLaMA` + `r/ClaudeAI` (MCP angle).

### Developer-at-large

- **Hacker News** — "Show HN: MCP server for Catalan open data". Lead with *what you can now ask*, not the tech. Tuesday/Wednesday morning ET.
- **Anthropic Discord** `#mcp` channel — showcase post.
- **Product Hunt** — works if the demo video is good. Middling signal, worth ~1 hour.

### Stretch: official adoption (revisit after traction)

- Pitch **Generalitat — Direcció General d'Innovació Digital** for a "community tools" link. What sells: attribution, uptime, bilingual docs, maintenance clarity.
- Same for IDESCAT and Open Data BCN.

### Sequencing

1. **Week 1** — ship npm + MCPB alpha, record demo, write example-gallery README.
2. **Week 2** — deploy hosted Streamable HTTP, Docker image, and MCP Registry metadata.
3. **Week 3** — submit to aggregators, post Show HN + r/ClaudeAI, Spanish-language thread.
4. **Week 4** — cold-email Generalitat/IDESCAT/BCN, publish build-post, pitch BarcelonaJS talk.

MCP Registry + Desktop Extension + demo video + HN cover ~80% of reach.

## Revision history

### Round 1 — codex exec critique

Comprehensive revision in response to 20+ concerns. Major changes:

- **IDESCAT tool surface rewritten** from `indicadors/v1`-style generic indicator search to `taules/v2`-native statistics/nodes/tables/geos/data flow. The original tools didn't match either IDESCAT API.
- **Added Open Data BCN (CKAN) as a third adapter** — the `arbrat viari` tree demo lives there, not in Socrata or IDESCAT. Without this, the flagship demo was out of scope.
- **Socrata surface pinned**: catalog via portal DCAT `data.json`, queries via v3 `/api/v3/views/{id}/query.json` with legacy fallback. Previously ambiguous.
- **Renamed `list_dataset_attachments` → `list_dataset_resources`** (DCAT distributions cover more than "attachments").
- **Scoped `get_dataset_stats`** to verified fields only; `page_views`/`downloads` removed unless confirmed stable.
- **Dropped unified `search`** — Socrata datasets / IDESCAT tables / CKAN packages are different object types; cross-source dedupe hides useful distinctions.
- **Mandatory provenance envelope** (`source`, `source_url`, `id`, `last_updated`, `license_or_terms`, `language`) on every response. Required by IDESCAT terms.
- **Added geospatial helper** `query_dataset_geo` — the tree/air-quality demos can't work without it.
- **Added Catalan geography normalization** (municipi/comarca/provincia) as a separate helper.
- **JSON-stat flattening** mandated for IDESCAT responses.
- **Health endpoint split** into `/live` (shallow) + `/ready`. Dropped upstream-probing health (amplifies incidents).
- **Deferred HTTP transport to phase 2** — stdio-first; validate data abstractions before doubling scope.
- **Dropped Cloudflare Workers** (not full Node). Fly.io only.
- **Cache scope clarified**: in-memory LRU is local-only; hosted is opportunistic. Shared cache out of v1.
- **Added hosted abuse controls**: rate limit, concurrency cap, timeouts, 429s.
- **Pinned MCP SDK to v1.x** (v2 is pre-alpha).
- **Fixed Socrata claims**: app token = "currently unthrottled," not "unlimited/day"; `$order` required for pagination.
- **Distribution updated**: `modelcontextprotocol/servers` replaced with **MCP Registry**. Added **Claude Desktop Extension bundle** as primary end-user install path.
- **Added contract tests** alongside `nock` unit tests.
- **Preserved upstream errors** via `source_error` field.
- **Reworded "zero-install"** — HTTP avoids local runtime setup but clients still need config.

### Round 2 — codex exec critique

Five specific concerns, all addressed:

- **IDESCAT `geo` path segment added** — Taules v2 URLs are `/{statistics}/{node}/{table}/{geo}[/data]`. `get_table_metadata` and `get_table_data` now take `geoId`. Safe-narrowing flow updated: `… → list_table_geos → get_table_metadata → get_table_data`.
- **IDESCAT real error shape encoded** — JSON-stat `{ class: "error", status, id, label }` + HTTP 416 with internal code `05` for cell overflow. Surfaced as `NarrowFiltersError` with upstream details in `source_error`.
- **Socrata v3 downgraded to contract-test-gated** — v3 availability on `analisi.transparenciacatalunya.cat` is not assumed; each dataset gated by test, with legacy SODA 2.1 / `rows.json` as fallback. `query_dataset` now uses v3 `page` object where available. `ORDER BY :id` injection conditional — skipped when `group`/aggregate in `select`.
- **BCN two base paths modeled explicitly** — `/data/api/3/action/*` for catalog, `/data/api/action/datastore_*` for DataStore. `query_resource` checks `datastore_active` and raises `DataStoreUnavailableError` when false.
- **v1 deployment contradiction resolved** — Docker + `/live` + `/ready` + `docker-compose` moved to phase 2 alongside HTTP transport. v1 ships stdio only (npm + Desktop Extension). A detached stdio container wasn't a usable MCP endpoint anyway.
- **Canary assets section added** — Socrata / IDESCAT / BCN each get a pinned ID before v1 ships; these anchor contract tests, README screenshots, and demo recordings.

### Round 3 — codex exec critique

Three remaining blockers, all resolved:

- **IDESCAT `search_tables` added** — Taules v2 has no native search, so the adapter builds a local index on first use (list_statistics → list_nodes → list_tables, cached 24h). Hierarchical traversal was the only discovery path and couldn't support prompts like "baby names" or "unemployment by comarca" without the LLM knowing the hierarchy upfront.
- **BCN schema introspection guaranteed** — `get_resource_info` now returns field schema (`{ id, type }[]`) for active DataStore resources, fetched via `datastore_search?limit=0`. `query_resource` and `run_ckan_sql` are no longer blind.
- **Response caps defined** — hard row / byte / timeout limits on every data-returning tool, with a typed `truncated` signal so the model knows when output is partial. Prevents one broad query from producing an unusable MCP response even when upstream allows it.

**Convergence**: round 3 critique explicitly says "everything else looks v1-sane" and the only open item (canary IDs) is an execution gate, not a design blocker. Plan considered converged.

### Round 4 — convergence confirmation

Codex round 4: **"No remaining design-level blockers … the plan is converged for v1 shipping."** Only editorial nit — phase-2 artifacts (`http.ts`, `Dockerfile`, `docker-compose.yml`) marked inline in the architecture tree rather than listed as if they were v1 files.

### Round 5 — architecture upgrade for 2026 MCP expectations

This round intentionally supersedes the earlier "stdio-only v1" convergence:

- **Source adapters made the architectural center** — Socrata, IDESCAT, and BCN are bounded contexts behind a shared `SourceAdapter` contract. MCP tools/resources/prompts sit above the source layer instead of owning upstream logic.
- **MCP-native result contract added** — every tool now returns `structuredContent`, a text fallback, and a declared `outputSchema`.
- **Resources and prompts added** — metadata/schema context is exposed through resource templates; common workflows are exposed as user-controlled prompts.
- **Tool names dot-namespaced** — source-native tools use `socrata.*`, `idescat.*`, `bcn.*`, and `geo.*` for clarity and action controls.
- **Compatibility `search`/`fetch` restored carefully** — not as a fake unified product surface, but as a thin typed-reference bridge for clients and deep-research/company-knowledge workflows.
- **Hosted Streamable HTTP moved into public v1** — npm + MCPB remains the local alpha path, but the public product includes `/mcp`, Docker, registry metadata, and transport security from launch.
- **BCN geospatial helper added** — the flagship tree demo no longer depends on raw SQL or fragile text filtering.
- **Raw query tools hardened** — SoQL and CKAN SQL are advanced, capped, single-statement, parser/shape-gated escape hatches.
- **Architecture quality gates added** — v1 is not done until source isolation, structured outputs, canaries, resources, and transport smoke tests all hold.
