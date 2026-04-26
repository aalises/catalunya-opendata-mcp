# Plan: IDESCAT Connector

## Summary / Assessment
- Build a full IDESCAT v1 slice on top of the Tables v2 API: generated table search, hierarchical browsing, geo discovery, metadata, flattened data, one metadata resource, and workflow guidance.
- Sequence the work in three PRs: (1) narrowly close the `source_error` end-to-end gap on the Socrata side; (2) behavior-preserving extraction of Socrata MCP registration into `src/mcp/tools/socrata.ts`; (3) IDESCAT connector under `src/sources/idescat/` plus `src/mcp/tools/idescat.ts` with prompts, resource, and search index.
- Current repo is green before changes: `npm run typecheck` and `npm test` pass with 9 files and 73 tests.
- IDESCAT Tables v2 is the correct target: it exposes JSON-stat metadata/data at `/{statistics}/{node}/{table}/{geo}` and `/data`, supports `ca`/`es`/`en`, filters, `_LAST_`, GET/POST, and returns structured JSON-stat errors including HTTP 416/internal `05` for data-limit overflow.

## Public Surface
- Tools: `idescat_search_tables`, `idescat_list_statistics`, `idescat_list_nodes`, `idescat_list_tables`, `idescat_list_table_geos`, `idescat_get_table_metadata`, `idescat_get_table_data`.
- Prompts: `idescat_query_workflow`, `idescat_citation`. Both prompts explicitly instruct callers to invoke `idescat_get_table_metadata` before final citation, since `SourceOperationProvenance` keeps `license_or_terms: null` (`src/sources/common/provenance.ts:14`) and IDESCAT API terms / `statistical_sources` are surfaced only through dataset metadata.
- Resource template: `idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata`.
- Default `lang` is `ca`; only `ca | es | en` accepted everywhere.
- Tools are designed for **bounded extracts, not exhaustive table export**. The data tool description, the workflow prompt, and the README all say so explicitly. There is no fake pagination over flattened cells.

## Validation Boundaries (MCP Schema vs Source Adapter)
A consistent rule across all IDESCAT tools, matching `socrata_query_dataset`'s pattern at `src/mcp/server.ts:64`–`65` (NOT `socrata_search_datasets`'s stricter pattern at `src/mcp/server.ts:37`):

- **MCP input Zod schemas stay loose** for every field whose rejection should produce a structured `{ data: null, provenance, error }` envelope:
  - `limit?: z.number().optional()` — NO `.int()`, NO `.max()`. Fractional and out-of-range values are rejected by the source adapter (`normalizeLimit` style at `src/sources/socrata/query.ts:226`) so the tool returns the envelope. The existing assertion at `tests/mcp/server.test.ts:462`–`497` proves this contract for fractional `limit`/`offset`.
  - `last?: z.number().optional()` — same treatment; safe-integer + `>= 1` validation lives in the adapter.
  - `filters?: z.record(z.unknown()).optional()` — `z.record(z.union([z.string(), z.array(z.string())]))` would reject non-string values at the SDK layer with no envelope. The loose `unknown` shape lets `filter-validation.ts` reject keys/values with `IdescatError('invalid_input', ...)`.
  - IDs are raw `z.string()` at the MCP layer (NO `.trim()`, NO `.min()`). Whitespace, empty, and content rejection is the adapter's job via `safePathSegment` so the contract matches the test plan's whitespace expectations.
- **MCP input Zod schemas stay strict** only where SDK-level rejection without provenance is acceptable: `lang: z.enum(['ca','es','en']).default('ca')`. (A bad `lang` value is a programmer error, not a user-facing one.)
- "Every IDESCAT tool result includes provenance" holds for adapter-validated inputs (`limit`, `last`, `filters`, ID content). Pure-shape MCP-layer rejections (wrong type, missing required field) yield `isError: true` without the envelope, same as `tests/mcp/server.test.ts:263`.

## Schema Factories
Schemas are produced by factory functions, not constants, because both Socrata and IDESCAT depend on `config.maxResults` (`src/mcp/server.ts:34`/`37`/`42`):

- `createSocrataSchemas(config)` returns `{ inputs: {...}, outputs: {...} }` — extracted in PR 2 from the inline schemas at `src/mcp/server.ts:34`–`67` and `src/mcp/server.ts:388`–`458`.
- `createIdescatSchemas(config)` produces the IDESCAT Zod schemas (input + output) under "Tool Input/Output Schemas" below.
- `createSourceToolErrorOutputSchema(source: SourceId)` returns a per-source error schema with `source: z.literal(source)` and `code: z.string()` — preserves the Socrata `z.literal("socrata")` invariant at `src/mcp/server.ts:369` while letting IDESCAT have its own `z.literal("idescat")`. It includes the optional `source_error: z.unknown()` field. The plan no longer proposes a single shared error schema across sources.

## PR 1 Scope: `source_error` End-to-End (Socrata-Only Touch)
The shared `SourceError` already accepts `source_error` (`src/sources/common/errors.ts:17`/`26`/`35`). Plumbing it end-to-end on Socrata requires changes in three places — none of the current Socrata error-construction paths set `source_error`, so the spy-based "throw with `source_error`" test cannot work without an additional production change:
- Update `SocrataError` constructor at `src/sources/socrata/client.ts:20` to accept `source_error?: unknown` and forward it to `super(...)`.
- Update `createHttpError` at `src/sources/socrata/client.ts:177`–`188` to attach the parsed body (when JSON) to `source_error` in addition to the existing message excerpt. This is the smallest change that makes a real production path emit `source_error` for the end-to-end test, and Socrata's 400 responses (`tests/mcp/server.test.ts:503`) are a natural fixture.
- Update `toSocrataToolError` at `src/mcp/server.ts:460` to copy `error.source_error` onto the structured tool error when present, after passing it through `toJsonSafeValue` (see "JSON-safe normalization" below).
- Add `source_error: z.unknown().optional()` to the existing `socrataToolErrorOutputSchema` at `src/mcp/server.ts:369`. (`createSourceToolErrorOutputSchema` is introduced in PR 2 and replaces this inline schema.)
- Keep the existing fallback path that uses `code: "unexpected_error"` (`src/mcp/server.ts:474`) unchanged — `code` stays `z.string()`.
- **End-to-end test**: a 400-response fixture exercises the real `createHttpError` → tool handler path; assert `result.structuredContent.error.source_error` equals the round-tripped JSON-safe form of the upstream body (and existing `error.message` assertions at `tests/mcp/server.test.ts:503` keep passing). Once PR 2 makes the mapper a module-level export, also add a direct unit test for the mapper.

### JSON-safe Normalization
`createJsonTextContent` (`src/sources/common/caps.ts:14`) calls `JSON.stringify(structuredContent)` with no replacer; passing a `BigInt`, an `Error`, a `Response`, a circular object, or a function anywhere in the structured content either throws or silently serializes to `{}`. Add `src/sources/common/json-safe.ts`:

- `toJsonSafeValue(value: unknown): JsonValue | undefined` — returns the value unchanged if it is already a JSON value (string, number, boolean, null, plain object, array of JSON values, recursively); `Error → { name, message }`; `BigInt → string`; `URL → string`; functions and unknown class instances → `undefined`; cycles → `undefined` for the recursing edge.
- `createJsonTextContent(structuredContent)` runs its argument through `toJsonSafeValue` before stringifying. This is the **last-line guard** — IDESCAT preserves unknown `extensions`, full link metadata, and request diagnostics (`URL` instances), so a stray non-JSON value anywhere in `structuredContent` (not just `source_error`) would otherwise blow up the response or silently serialize to `{}`.
- The Socrata `toSocrataToolError` and the IDESCAT mapper still run `source_error` through `toJsonSafeValue` explicitly (defense-in-depth) so the structured-content path produces the same shape regardless of the boundary guard.
- Unit-tested with `BigInt`, `Error`, `URL`, circular object, plain object, `null`. Add a separate test asserting `createJsonTextContent({ url: new URL('https://x'), bad: () => {} })` produces a parseable JSON string with `url` as a string and `bad` absent.

## Tool Input/Output Schemas
For every IDESCAT tool, define explicit Zod input and output schemas via `createIdescatSchemas(config)` in `src/mcp/tools/idescat-schemas.ts`. Outputs use `createSourceToolErrorOutputSchema("idescat")` for the `error` field.

- `idescat_search_tables`
  - Input: `{ query: z.string().trim().min(1), lang?: z.enum(['ca','es','en']).default('ca'), limit?: z.number().optional() }`. `limit` safe-integer validation, cap (`maxResults`), and default (`min(10, maxResults)`) are applied inside the source adapter so invalid values return a structured tool envelope.
  - Output `data`: `{ query, lang, requested_lang, limit, total, generated_at: string, index_version: string, source_collection_urls: string[], results: TableSearchCard[] }`.
  - `TableSearchCard`: `{ statistics_id, node_id, table_id, label, ancestor_labels: { statistic, node }, geo_candidates: string[] | null, score: number, lang: 'ca'|'es'|'en', source_url: string }`.
- `idescat_list_statistics`: `{ lang? }` → `{ collection: { label, href, version: string|null, lang }, items, total: number, limit: number, offset: number, truncated: boolean, truncation_reason?: 'row_cap' | 'byte_cap' }`.
- `idescat_list_nodes`: `{ statistics_id: z.string(), lang? }` → same envelope shape with `items: Array<{ statistics_id, node_id, label, href }>`.
- `idescat_list_tables`: `{ statistics_id, node_id, lang? }` → same envelope shape with `items: Array<{ statistics_id, node_id, table_id, label, href, updated?: string }>`.
- `idescat_list_table_geos`: `{ statistics_id, node_id, table_id, lang? }` → same envelope shape with `items: Array<{ statistics_id, node_id, table_id, geo_id, label, href }>`. **Critical case** — a single table can expose thousands of geo categories; the row-cap/byte-cap discipline below prevents oversized responses.
- All four `list_*` tools accept loose `limit?: z.number().optional()` and `offset?: z.number().optional()` (matching the validation boundary). The adapter applies `min(50, maxResults)` default for `limit`, validates `offset >= 0`, and runs the same envelope-aware byte-cap binary search as the data tool — items get truncated with `truncation_reason: 'row_cap'` (caller exceeded their `limit`) or `'byte_cap'` (envelope > `responseMaxBytes`). `total` reflects the pre-truncation length.
- `idescat_get_table_metadata`
  - Input: `{ statistics_id: z.string(), node_id: z.string(), table_id: z.string(), geo_id: z.string(), lang?: z.enum(['ca','es','en']).default('ca') }`.
  - Output `data`: `IdescatTableMetadata` (see "Metadata Payload Fields"). Tool calls run the same degradation ladder as the resource — see "Metadata Path Sizing".
- `idescat_get_table_data`
  - Input: `{ statistics_id: z.string(), node_id: z.string(), table_id: z.string(), geo_id: z.string(), lang?: z.enum(['ca','es','en']).default('ca'), filters?: z.record(z.unknown()).optional(), last?: z.number().optional(), limit?: z.number().optional() }`. Loose number/record shapes per "Validation Boundaries" so the source adapter can produce the envelope. The adapter validates safe-integer + `>=1` for `last`, `<= maxResults` for `limit`, filter keys/values, and ID safety, throwing `IdescatError('invalid_input', ...)` on failure.
  - Output `data`: see "IDESCAT Data Output Envelope".
- All tool results include `provenance: SourceOperationProvenance<'idescat'>`. List/search outputs also expose `collection.href` for independent audit.

## Filter and URL Size Caps
Mirror Socrata's `SOCRATA_QUERY_CLAUSE_MAX_BYTES` / `SOCRATA_QUERY_URL_MAX_BYTES` discipline at `src/sources/socrata/query.ts:20`–`25`. Without these, callers passing thousands of filters or very long values can blow the response cap before any rows exist — and binary-searching `rows.length` cannot recover an envelope dominated by echoed URLs.

- `IDESCAT_FILTER_KEY_MAX_BYTES = 64` — per filter key (UTF-8 byte length via `getUtf8ByteLength`).
- `IDESCAT_FILTER_VALUE_MAX_BYTES = 256` — per individual filter value (each element of an array counts independently).
- `IDESCAT_FILTER_COUNT_MAX = 32` — max number of dimension keys per request.
- `IDESCAT_FILTER_TOTAL_MAX_BYTES = 4_096` — total bytes across all filter keys+values after canonicalization.
- `IDESCAT_LOGICAL_URL_MAX_BYTES = 8_192` — same ceiling Socrata uses for query URLs (`SOCRATA_QUERY_URL_MAX_BYTES`).
- `IDESCAT_POST_BODY_MAX_BYTES = 16_384` — POST is the escape hatch for long filters; cap it explicitly.

Each cap rejects with `IdescatError('invalid_input', ..., { source_error: { rule, observed, limit } })`.

## Filter Canonicalization
GET URLs and POST bodies are built from a deterministic canonical form so identical filter intent produces identical `logical_request_url` and `provenance.source_url`:

1. Sort filter keys lexicographically (Unicode code-point order).
2. Within a single key, preserve caller insertion order for array values (callers may rely on order semantics; we don't reorder).
3. Join multi-value filters with commas (IDESCAT convention; comma-containing values are already rejected by `filter-validation.ts`).
4. Build the GET form first, run all size caps against it, then decide GET vs POST using `getUrlByteLength(canonicalGetUrl)` (UTF-8 bytes — same helper at `src/sources/common/caps.ts:13`–`15` the rest of the codebase uses). POST is selected when **`getUrlByteLength(canonicalGetUrl) > 2_000`**; exactly 2,000 stays GET.

Tests pin the boundary using the same `getUrlByteLength` function, percent-encoded non-ASCII, and the canonicalization order.

## IDESCAT Data Output Envelope
- `idescat_get_table_data.data`:
  - `statistics_id`, `node_id`, `table_id`, `geo_id`, `lang`
  - `request_method: 'GET' | 'POST'`
  - `request_url`: actual HTTP request URL (short, body-less form for POST; full GET URL for GET).
  - `request_body_params?: Record<string, string>`: present iff `request_method === 'POST'`. Body content type is `application/x-www-form-urlencoded`.
  - `logical_request_url`: canonical GET-equivalent URL for reproduction. Always present.
  - `filters?: Record<string, string | string[]>`, `last?: number`, `limit: number`
  - `dimension_order: string[]` driven by JSON-stat `id`; `size: number[]` parallel array.
  - `units?: { default?: { symbol?: string, decimals?: number }, by_dimension?: Record<dimensionId, Record<categoryId, { symbol?: string, decimals?: number }>> } | null`.
  - `row_count: number`, `selected_cell_count: number` (Cartesian product of selected category counts from the returned dataset's `size`), `truncated: boolean`
  - `truncation_reason?: 'row_cap' | 'byte_cap'`, `truncation_hint?: string`
  - `rows: Row[]` where `Row = { value: number | null, status?: { code: string, label?: string }, dimensions: Record<dimensionId, { id, label }> }`.
  - `notes?: string[]`, `source_extensions?: Record<string, unknown>` (catch-all for unknown JSON-stat extensions on the dataset).
- **Sparse-value emission policy**: only cells whose JSON-stat `value` is explicitly present (number OR `null`) become rows. The Cartesian product is NOT materialized; absent indices in object-form `value` produce no row. `selected_cell_count` reflects the Cartesian product so callers can detect sparseness as `selected_cell_count > row_count`.
- **Truncation hints** (explicit about the bounded-extract design):
  - `row_cap`: "raise limit (within maxResults) or narrow filters via dimension IDs / `_LAST_` — IDESCAT data tools are for bounded extracts, not exhaustive export".
  - `byte_cap`: "narrow filters or use `_LAST_` to reduce upstream cells — IDESCAT data tools are for bounded extracts".
- **Overflow contract — error model, single source of truth**: HTTP 416 / internal `05` (or any structured upstream `class: "error"` indicating cell-limit overflow) returns `{ data: null, error: { code: 'narrow_filters', source_error: <jsonstat-error-body> } }`. There is no `truncation_reason: 'cell_overflow'` in the data envelope — tools at `src/mcp/server.ts:119`/`199` use the error-envelope pattern and the schema does not allow partial data plus `error`.
- **No metadata cache**: pre-flight cell-count rejection is dropped from this slice. The current source layer is stateless (`src/sources/socrata/dataset.ts:84`, `src/mcp/server.ts:289`). IDESCAT relies on upstream HTTP 416 / internal `05` to signal overflow.
- **Capping pipeline** (post-fetch only):
  1. Validate input including `limit ≤ config.maxResults` (default `min(100, maxResults)` matching `src/sources/socrata/query.ts:226`); out-of-range throws `invalid_input`.
  2. Fetch with `successBodyMaxBytes = config.idescatUpstreamReadBytes`.
  3. Flatten under `dimension_order`. Truncate to `limit` (stamping `truncation_reason: 'row_cap'`).
  4. Byte-cap with envelope-aware loop (`getJsonToolResultByteLength({ data, provenance })`) using **binary search over `rows.length`** — O(log n) JSON serializations vs Socrata's O(n) decrement at `src/sources/socrata/query.ts:329`.

## Operation Provenance for POST
- `provenance.source_url` is the **`logical_request_url`** for both GET and POST IDESCAT data calls — the canonical, reproducible GET form. This is consistent with provenance's citation purpose, even when the actual upstream call was a POST whose body held filters.
- `data.request_url` and `data.request_body_params` carry the actual upstream wire form for transparency/debugging.
- The README documents this split so users know `provenance.source_url` reproduces the logical request, while `data.request_url` reflects the literal HTTP transaction.

## Provenance Fallback for Invalid Input
When the source adapter rejects input before a request URL can be safely composed (e.g., an unsafe path segment, a comma-containing filter value, an oversized canonical URL), the tool catch block still has to build a `SourceOperationProvenance<'idescat'>` for the envelope. Mirrors `createSocrataQueryProvenance`'s root-domain fallback at `src/sources/socrata/query.ts:136`–`147` and the test at `tests/sources/socrata/query.test.ts:262`–`267`.

Per-operation fallbacks (NEVER echo unsafe raw caller input into `source_url`):
- Search / list operations: the safe operation root URL — e.g. `https://api.idescat.cat/taules/v2?lang=ca` for list_statistics, with already-validated `lang` if present, otherwise `ca`.
- Metadata / data: the same safe operation root, NOT a partially-composed tuple URL.
- `id` field uses a stable string like `idescat:tables:operation_root` — no caller input.
- Tests assert that a `SocrataError`-style fallback (`tests/sources/socrata/query.test.ts:262`) returns provenance with the safe URL and never reflects the malicious / oversized input.

## Metadata Payload Fields (`IdescatTableMetadata`)
Single shape used by both `idescat_get_table_metadata.data` and the metadata resource. Either path may set `degradation` when the artifact would otherwise exceed the relevant MCP response cap (see "Metadata Path Sizing"):

- `statistics_id`, `node_id`, `table_id`, `geo_id`, `lang`
- `title`, `description?`
- `dimensions`: array preserving JSON-stat `id`/`size` order, each item:
  - `id`, `label`, `role?: 'time' | 'geo' | 'metric'`, `size: number`
  - `unit?: { symbol?: string, decimals?: number }` — dimension-level default unit (separate from per-category unit).
  - `status?: Record<string, string>` — `categoryId → statusCode` map parsed from `dimension.{id}.extension.status`. Used by the row status priority described below.
  - `categories: Array<{ id, label: string, index: number, parent?: string, unit?: { symbol?: string, decimals?: number }, status?: string }>`. Missing category labels fall back to `label = id` (no `invalid_response`).
  - `categories_omitted?: boolean` — set to `true` only by the metadata degradation ladder; `false`/omitted otherwise.
  - `breaks?: Array<{ time: string, id: string, label: string, raw?: Record<string, unknown> }>` parsed from `dimension.{id}.extension.break` per the IDESCAT Tables API docs (`https://www.idescat.cat/dev/api/taules/?lang=en`); `raw` preserves the source object verbatim.
  - `extensions?: Record<string, unknown>` preserves unknown dimension-level extension keys.
- `notes?: string[]` (IDESCAT returns string-array form, NOT structured `{ level, text }`).
- `statistical_sources?: string[]` (IDESCAT exposes source as an array-shaped extension; collapsing to a single string would lose multi-source metadata).
- `units?` (same shape as the data envelope; mirrored on metadata for citation).
- `status_labels?: Record<string, { label: string, raw?: Record<string, unknown> }>` parsed from the nested `extension.status.label.{code}` form per the docs.
- `links?: Array<{ rel: string, href: string, label?: string, class?: string, type?: string, extension?: Record<string, unknown> }>` — full link objects preserved verbatim.
- Convenience derivations (computed from `links` and the request tuple):
  - `correction_links`: `links` with `rel === 'monitor'`.
  - `alternate_geographies`: `links` whose href segments share `{statistics_id, node_id, table_id}` with the current request but differ in `geo_id`.
  - `related_tables`: `links` whose href segments differ in `{statistics_id, node_id, table_id}` from the current request.
- `terms_url?` when the dataset surfaces an API-terms link.
- `last_updated?` from JSON-stat `updated` (also set on `provenance.last_updated`).
- `extensions?: Record<string, unknown>`: dataset-level extension catch-all. Dimension-level extensions, such as the canary's `%` key on `CONCEPT`, are preserved under `dimensions[*].extensions`.
- `provenance: SourceDatasetProvenance<'idescat'>` — nested dataset-level provenance with `source_url`, `id`, `last_updated`, `license_or_terms` (terms text when the dataset surfaces them), and `language`. Mirrors the Socrata convention at `src/sources/socrata/dataset.ts:180`–`187` and the resource invariant at `tests/mcp/server.test.ts:137`–`150`. `idescat_citation` reads from this nested provenance plus `terms_url` / `statistical_sources` / `last_updated`.
- `degradation?: { dropped: Array<'categories_for_dimensions' | 'links' | 'notes' | 'extensions'>, dimension_ids?: string[], hint: string }` — set by the degradation ladder when the artifact would exceed the cap. Both tool calls and resource reads can produce `degradation` (see "Metadata Path Sizing").

**Status resolution per row, deterministic priority**:
1. JSON-stat per-cell `status` (array indexed by cell, or object keyed by cell index).
2. If no cell-level status, walk the row's selected dimensions in JSON-stat `id` order; the first dimension whose `status[categoryId]` (parsed under `dimensions[*].status`) yields a code contributes the status.
3. Otherwise no `status`.
Status `code → label` resolution always reads through `status_labels[code].label`.

## Metadata Path Sizing
**Critical**: a full IDESCAT table with thousands of municipalities or sections can exceed `config.responseMaxBytes` even before the tool path doubles the payload via `createJsonTextContent` (`src/mcp/server.ts:151`–`153`). Both `idescat_get_table_metadata` and the `idescat://tables/.../metadata` resource therefore run the same degradation ladder; only the size-measurement helper differs.

- Tool path: size with `getJsonToolResultByteLength({ data, provenance })` (already used by Socrata query at `src/sources/common/caps.ts:29`–`38`) — accounts for `structuredContent` + JSON text fallback.
- Resource path: size with a new `getJsonResourceResponseByteLength(uri, mimeType, payload)` helper that mirrors the actual `{ contents: [{ uri, mimeType, text: JSON.stringify(payload) }] }` shape. Account for the JSON-RPC re-escaping by computing `getJsonByteLength` on the wrapped object, NOT just the inner artifact.

**Resource shape**: returns the `IdescatTableMetadata` artifact directly (NO outer `{ data, meta }` wrapper) — same convention as Socrata's metadata resource at `src/mcp/server.ts:296` and the test invariant at `tests/mcp/server.test.ts:149`. Degradation is communicated via the optional `degradation` field on the artifact itself, identical for both paths.

**Resource error model**: malformed/missing/array-typed/repeated URI variables throw `IdescatError('invalid_input', ...)`. The MCP SDK turns this into a JSON-RPC read-resource error, matching `tests/mcp/server.test.ts:174` (no `isError: true` content envelope, no `data: null` body). The README "Resources" section documents this.

**Degradation ladder** (apply in order, recomputing the size with the path-appropriate helper after each step; the artifact always conforms to `IdescatTableMetadata`):
1. Drop `categories` (replace with `[]`, set `categories_omitted: true`) for any dimension with > 200 categories. Hint: `"call idescat_list_table_geos for geo dimensions or call idescat_get_table_metadata after narrowing the table"`. Mention `idescat_list_table_geos` **only when at least one dropped dimension has `role === 'geo'`**.
2. Drop `links`.
3. Drop `notes`.
4. Drop `extensions` (dataset-level only — `source_extensions` is data-envelope-only).
5. If still over cap: drop `categories` for ALL dimensions, set `dimension_ids = <all ids>`.
6. If step 5 still exceeds the cap, throw `IdescatError('invalid_response', ...)` — surfaced as a JSON-RPC error for resources, as a tool envelope error for tools.

## Search Index Language Strategy
- Always commit all three modules: `src/sources/idescat/search-index/ca.ts`, `es.ts`, `en.ts`. Each exports `{ default: IdescatSearchIndexEntry[], generatedAt, indexVersion, sourceCollectionUrls }`. Empty languages commit `default: []` with valid metadata exports — never a missing module.
- **Sharding remediation**: if a single-language array exceeds 1 MiB after refresh, the script writes per-statistic shards to `src/sources/idescat/search-index/{lang}/{statistics_id}.ts` and a `src/sources/idescat/search-index/{lang}/index.ts` that imports and concatenates them. The plan ships the helper code path in PR 3 even when the initial committed indices are small, so the upgrade is a refresh-script switch, not a future architectural change.
- Search ranking normalization (`normalizeSearchTerm`): Unicode NFD → strip combining diacritics → lowercase → whitespace collapse → trim. Multi-token queries require all tokens to match (AND); token order does not affect ranking. Index keywords concatenate the entry's own label plus its ancestor `statistic.label` and `node.label`.
- `idescat_search_tables` selects the index by `lang`. If the chosen index is empty AND `lang !== 'ca'`, fall back to `ca`, set `provenance.language = 'ca'`, and set `data.requested_lang = <input>` so callers see the divergence honestly.
- `geo_candidates` ships as `null` for every card in this slice (pre-resolving geos per table multiplies refresh-script upstream calls). The field stays in the schema as a forward-compatible hook.
- The refresh script `scripts/refresh-idescat.ts` crawls collection endpoints with sequential pacing (≥250 ms gap, exponential backoff with jitter on 429/5xx). Add `"refresh:idescat": "tsx scripts/refresh-idescat.ts"` to `package.json:40`. The refresh script is NOT part of `npm test` or CI.
- **Index freshness — operational trade-off, called out explicitly**: this slice ships `idescat_search_tables` against a manually-refreshed committed index. The README says so, and `data.generated_at` is part of every search response so MCP clients can decide whether to trust the index. At runtime, the search code path logs a structured `index_stale` warning via `createLogger(config).child({ source: 'idescat' })` (NOT `console.warn`, which would bypass `LOG_LEVEL` at `src/logger.ts:23`/`69`) when `generatedAt` is older than 365 days. CI does NOT fail on staleness — that would block emergency releases — but the README documents that maintainers must run `npm run refresh:idescat` and commit on a regular cadence (suggested: monthly) to keep search useful. The non-blocking warning is a backstop, not a guarantee.

## Search Ranking Tests Use Injected Fixtures
Search-ranking unit tests do NOT depend on the contents of the committed index modules (which may legitimately be empty). They construct an `IdescatSearchIndexEntry[]` literal in the test file, pass it to a pure `rankIdescatSearchResults(entries, query)` function, and assert ranking outcomes (Catalan, Spanish, English term variants, accentless matches, multi-token AND). Module-loading tests are kept small: assert exports exist, `generatedAt` parses, lengths are reasonable.

## Upstream Read Cap (IDESCAT-Specific)
- `config.responseMaxBytes` is hard-capped at 1 MiB (`src/config.ts:38`); a 20,000-cell IDESCAT response with full dimension labels can exceed that.
- New env: `CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES` (matches the `CATALUNYA_MCP_*` prefix at `.env.example:6` / `src/config.ts:26`), default 8 MiB (`8_388_608`), max 32 MiB.
- Add `idescatUpstreamReadBytes: number` to `AppConfig` via `src/config.ts:21`.
- **Test fixture blast radius** (must be updated in PR 3):
  - Six literal `AppConfig` fixtures: `tests/mcp/server.test.ts:9`, `tests/sources/socrata/catalog.test.ts:14`, `tests/sources/socrata/dataset.test.ts:10`, `tests/sources/socrata/client.test.ts:9`, `tests/sources/socrata/query.test.ts:13`, `tests/contracts/socrata.fixtures.test.ts:9`.
  - `tests/config.test.ts:7` (`returns narrow defaults` uses `.toEqual({...})` so the new key must be added) and `tests/config.test.ts:18` (`coerces numeric caps` ditto).
  - Add new `tests/config.test.ts` cases for `CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES` min/max/coercion, mirroring the existing `CATALUNYA_MCP_RESPONSE_MAX_BYTES` cases at `tests/config.test.ts:43`–`53`.
  - Introduce `tests/helpers/config.ts` exposing `createTestConfig(overrides?)` and migrate all the literal `AppConfig` fixtures to it, so future config additions are a one-line change.

## Non-2xx Body Reading Cap
`fetchIdescatJson` matches Socrata's discipline (`src/sources/socrata/client.ts:104` for success, `src/sources/socrata/client.ts:259` for errors). Two caps with explicit, non-overlapping responsibilities:
- **Non-2xx** body reads cap at 64 KiB. Within that, attempt `JSON.parse`; on failure, fall back to a 4 KiB UTF-8 excerpt and surface as `IdescatError('http_error', ..., { source_error: { kind: 'text_excerpt', excerpt } })`.
- **2xx** body reads cap at `config.idescatUpstreamReadBytes` (default 8 MiB). After the body is read, attempt `JSON.parse` and inspect the parsed value: if it has `class: "error"`, route through the same JSON-stat error mapper as the non-2xx path. The 64 KiB non-2xx cap does NOT apply here — a 2xx response is a valid HTTP success and the upstream read cap governs. A 2xx error body that legitimately exceeds 8 MiB is a pathological IDESCAT response and surfaces as `IdescatError('invalid_response', "Upstream success body exceeded the configured read cap.")`, which is honest about the failure mode.

## Key Implementation Changes
- Add `src/sources/idescat/` with:
  - `client.ts`: purpose-built `fetchIdescatJson`. Always reads the response body before deciding error vs success. Uses the success cap and the 64 KiB non-2xx cap above. Sends `Accept: application/json` and the existing `User-Agent: catalunya-opendata-mcp/${packageVersion}` pattern.
  - `request.ts`:
    - GET-vs-POST selection at the IDESCAT 2,000-character threshold using **strictly greater than 2,000 → POST**, matching the docs' "longer than" wording.
    - For POST: `lang`, `_LAST_`, and the `geo` path segment stay outside the body; only `filters` go into the `application/x-www-form-urlencoded` body.
    - `request_body_params: Record<string, string>` joins multi-value filters with commas per IDESCAT convention.
    - Always builds `logical_request_url` as the canonical GET equivalent.
    - Validates `last` as `Number.isSafeInteger(last) && last >= 1`.
  - `path-safety.ts`: `safePathSegment(name, value: string)` does NOT trim — leading/trailing whitespace is rejected, matching the test plan. Rejects empty, whitespace-containing, control-char-containing, or any segment containing `/`, `%`, `?`, `#`, `..`. Then `encodeURIComponent` is applied before URL composition. Filter VALUES are validated separately and reject commas (commas are reserved for the multi-value join).
  - `filter-validation.ts`: validates `filters: Record<string, string | string[]>`. Rejects (a) reserved dimension keys `lang` and `_LAST_` (those are top-level inputs), (b) empty arrays, (c) keys/values that are not non-empty strings, (d) values containing commas. Unknown filter dimensions/categories are an upstream concern (no metadata cache).
  - `catalog.ts`: parse JSON-stat collection responses into `{ collection: { label, href, version, lang }, items }`. **Href parsing is explicit, NOT a Socrata analogy** (Socrata uses explicit `resource.id` / `metadata.domain` at `src/sources/socrata/catalog.ts:97`/`129`; IDESCAT must derive IDs from `href`):
    - Resolve relative hrefs against the parent collection's `href`.
    - Strip trailing slashes before segment splitting.
    - Ignore query string and fragment when extracting IDs (preserve the original href verbatim in `items[].href`).
    - Validate that the parsed segment count and prefix match the requested parent tuple; mismatch → `IdescatError('invalid_response', ...)`.
    - Missing `href` → `IdescatError('invalid_response', ...)`.
  - `metadata.ts`: parses dataset metadata into the shape under "Metadata Payload Fields", including string-array `notes`, nested `extension.status.label`, `dimension.extension.break` per official docs, category-level `unit`, full link metadata, multi-source `statistical_sources`, and dataset/dimension/category extension catch-alls.
  - `data.ts` + `json-stat.ts`: flattens JSON-stat values explicitly handling: `category.index` as array OR object; `value` as array OR object (sparse — emit only present cells); per-cell `status`; dimension-level status (priority order above); dimension order from JSON-stat `id`; per-category units; metadata-only payloads with empty/absent `value` skip flattening; missing category labels fall back to `id`.
  - `search-index/index.ts`: loads the per-language compact index (or sharded form when present), exposes `generatedAt`/`indexVersion`/`sourceCollectionUrls`, ranks via `rankIdescatSearchResults`.
- Add `IdescatError` extending `SourceError<"idescat">` with codes `invalid_input`, `invalid_response`, `http_error`, `network_error`, `timeout`, `narrow_filters`. Constructor accepts `source_error?: unknown`.
- Resource URI segment validation:
  - Generic helper `getSingleTemplateVariable(name: string, value: string | string[] | undefined): string` lives in `src/mcp/tools/shared-helpers.ts`. It throws a generic `Error` (NOT a Socrata- or IDESCAT-specific error). Each source's resource handler catches and re-throws via its own typed error.
  - `getSocrataMetadataSourceId` (`src/mcp/server.ts:337`) is refactored to use the helper. IDESCAT does the same for each of its four segments, then runs each through `safePathSegment` + per-segment normalizer.

## MCP Module Split (PR 2 — Pre-IDESCAT Refactor)
- Behavior-preserving extraction of Socrata registration out of `createMcpServer` (`src/mcp/server.ts:26`).
- `src/mcp/server.ts` continues to export `createMcpServer`, `createPingMessage`, and `serverName` — the symbols imported by `tests/mcp/server.test.ts:6` that must not move. (`serverVersion` stays exported for external compatibility but is not in the test-import set.)
- New module `src/mcp/tools/socrata.ts` exposes `registerSocrataTools(server, config, logger)`. Schemas move to `src/mcp/tools/socrata-schemas.ts` as a `createSocrataSchemas(config)` factory (NOT a static export — see "Schema Factories"). The new `createSourceToolErrorOutputSchema` lives in `src/mcp/tools/shared-schemas.ts` and is consumed by both Socrata and IDESCAT.
- `createMcpServer` keeps logger setup, `ping`, `about`, and source registration calls.
- After PR 2, `toSocrataToolError` becomes `toSocrataToolError` (or a renamed equivalent) exported from `src/mcp/tools/socrata.ts` so PR 1's end-to-end coverage gains a direct unit test.
- All existing tests in `tests/mcp/server.test.ts` keep passing without changes.

## Public Documentation & Runtime "About"
- `README.md`: replace the Socrata-only framing in `README.md:5`; extend the tools / resources tables (`README.md:70`, `README.md:86`); add IDESCAT tools, prompts, resource template, workflow guidance, `narrow_filters` semantics (including the cell-limit case), citation guidance (call `idescat_get_table_metadata` before `idescat_citation`), the metadata-resource `degradation` ladder, the bounded-extract / no-pagination policy, and the explicit POST `provenance.source_url = logical_request_url` rule.
- Update the about resource text in `src/mcp/server.ts:323` to list IDESCAT support as current.
- Update `package.json:4` description to cover Socrata and IDESCAT, and add `idescat`, `jsonstat`, and `estadística` to keywords.
- Update `scripts/smoke.mjs` to assert IDESCAT tools, prompts (via `listPrompts()`), and resource templates (via `listResourceTemplates()`) are registered alongside the existing Socrata surface — explicit assertions per type. Update `tests/e2e/smoke.test.ts` similarly (source-based; no `dist/` assumptions).

## Build & Tooling Hygiene
- Add `scripts/**/*.ts` to `tsconfig.test.json:8` so the IDESCAT refresh script is type-checked. NodeNext ESM (`tsconfig.json:4`) means generated/imported TS files use `.js` import specifiers — match `src/mcp/server.ts:4`.
- Generated index `.ts` files use `: IdescatSearchIndexEntry[]` annotation, NOT `as const` or inferred literal types, to keep `dist/**/*.d.ts` size sane.
- **Generated-output size guards** (absolute only — `scripts/smoke.mjs` runs AFTER `npm run build` per `package.json:46` so the prior `dist/` is already overwritten and a delta guard would have no baseline):
  - `dist/sources/idescat/search-index/ca.d.ts` ≤ 32 KiB.
  - Each generated `.ts` source file under `src/sources/idescat/search-index/` ≤ 1 MiB. **Remediation when this triggers**: switch to per-statistic sharding (`src/sources/idescat/search-index/{lang}/{statistics_id}.ts`) — the loading code already supports it from PR 3. The guard is a release blocker only when sharding is also impossible.
  - No `dist/`-size-delta tracking in this slice. If a baseline becomes useful later, add a checked-in `dist-size-baseline.json` updated by a separate script.
- **Built-server smoke for IDESCAT** lives in `scripts/smoke.mjs` (after `npm run build`), NOT in `tests/e2e/smoke.test.ts` (which uses `tsx src/index.ts` at `tests/e2e/smoke.test.ts:18`).
- Add `npm run refresh:idescat` to `package.json:40` as `"refresh:idescat": "tsx scripts/refresh-idescat.ts"`. Document in `.env.example` and README.

## Test Plan
- Unit tests for IDESCAT URL construction (GET below 2,000 chars, GET at exactly 2,000 chars, POST strictly above 2,000 chars, body parameter list, `Content-Type: application/x-www-form-urlencoded`), header set, filter normalization for `string | string[]`, filter rejection for reserved keys (`lang`, `_LAST_`), empty arrays, comma-containing values, timeout / network / generic HTTP errors, JSON-stat error parsing on both non-2xx and 2xx bodies, **non-2xx body capping** (≤ 64 KiB; 4 KiB excerpt fallback for non-JSON), HTTP 416 / internal `05` → `narrow_filters` error envelope, invalid identifiers, **collection href parsing** (relative URL resolution, absolute URLs, trailing slashes, query-string ignoring, missing href, prefix mismatch), metadata parsing (string-array notes, IDESCAT-doc-shaped breaks, nested `extension.status.label`, category-level `unit`, links with `class`/`type`/`extension.group`, multi-source `statistical_sources`, dataset/dimension/category extension catch-alls), JSON-stat flattening with object-form `category.index`, sparse / `null` values (sparse-emission policy: only present indices yield rows), missing-category-label fallback to `id`, status resolution priority (cell → first selected dimension by `id` order → none), and metadata-only payloads with empty `value`.
- **`toJsonSafeValue`** unit tests: `BigInt → string`, `Error → { name, message }`, circular object → `undefined` for the recursing edge, plain JSON object passes through, `null` passes through, `function` → `undefined`.
- **`source_error` end-to-end** (PR 1): a mocked Socrata 400 response with a JSON body exercises the real `createHttpError` → tool-handler path; assert `result.structuredContent.error.source_error` is the round-tripped JSON-safe form while the existing bounded message excerpt remains intact.
- Path-safety tests for all four IDs: literal slash, `?`, `#`, `..`, leading/trailing whitespace, empty string, repeated/array URI variables; assert `fetch` is not called. Encoded-slash tests assert the **actual decoded value** that reaches `safePathSegment` for both single (`pmh%2F1180`) and double (`pmh%252F1180`) percent encoding — depending on MCP SDK URI parsing the variable may already be decoded once, and the test must pin which form the validator sees so it doesn't pass for the wrong reason.
- **Filter and URL size cap tests**: each cap (`IDESCAT_FILTER_KEY_MAX_BYTES`, `_VALUE_MAX_BYTES`, `_COUNT_MAX`, `_TOTAL_MAX_BYTES`, `IDESCAT_LOGICAL_URL_MAX_BYTES`, `IDESCAT_POST_BODY_MAX_BYTES`) — an over-cap input rejected as `invalid_input` with `source_error: { rule, observed, limit }` and the safe fallback `provenance.source_url` (no echoed caller input).
- **Filter canonicalization tests**: two filter objects with identical contents but different insertion order produce identical `logical_request_url`, identical `provenance.source_url`, and identical POST `request_body_params`. Boundary test for GET-vs-POST at the exact `getUrlByteLength === 2_000` (GET) and `=== 2_001` (POST) using the same helper.
- **List tool envelope tests**: each `list_*` tool returns `total`/`limit`/`offset`/`truncated`; `idescat_list_table_geos` with a synthetic 1,500-item collection truncates with `truncation_reason: 'row_cap'` (caller `limit < total`) and `'byte_cap'` (envelope > `responseMaxBytes`).
- **Metadata tool path degradation test**: a synthetic table with thousands of municipalities makes `idescat_get_table_metadata` produce a degraded artifact with `degradation.dropped`, mirroring the resource path. Tool size measured via `getJsonToolResultByteLength`; resource size via `getJsonResourceResponseByteLength`.
- **Metadata `provenance` test**: tool and resource both expose nested `IdescatTableMetadata.provenance` with `source_url`, `id`, `last_updated`, `license_or_terms`, `language`, matching the resource-artifact pattern at `tests/mcp/server.test.ts:137`–`150`.
- **Provenance fallback tests**: an oversized filter input or unsafe path segment yields an envelope whose `provenance.source_url` is the safe operation root (e.g. `https://api.idescat.cat/taules/v2?lang=ca`), NOT a partial URL composed from the bad input.
- **MCP-vs-source validation boundary** tests: `limit > maxResults` rejected via the source adapter as `invalid_input` with full `{ data: null, provenance, error }` envelope; missing required `lang` (wrong type) is rejected by Zod at the MCP layer with `isError: true` and no envelope, matching `tests/mcp/server.test.ts:263`.
- Fixture contract test using canary tuple `pmh/1180/8078/com`:
  - Unfiltered `/data` → `{ data: null, error: { code: 'narrow_filters', source_error } }`.
  - Filtered `{ COM: '01', SEX: 'F', last: 2 }` → populated rows, `truncated: false`, `dimension_order` matches `id`, units derived from `dimension.CONCEPT.category.unit.POP.decimals`, `breaks` preserved on `COM`, `extensions['%']` preserved on `CONCEPT`.
- **Synthetic near-limit cell-count fixture** (NOT a recorded multi-MiB payload). The test builds a JSON-stat object in code with `size = [40, 50, 10]` (20,000 cells), explicit sparse `value` covering ~18,000 indices, dimension order, and category labels. This exercises `idescatUpstreamReadBytes`, sparse policy, and binary-search byte-cap without committing a large opaque fixture to the repo.
- Output envelope tests: `truncated: false` happy path, `truncation_reason: 'row_cap'` when `limit` is below upstream count, `truncation_reason: 'byte_cap'` for an envelope exceeding `responseMaxBytes`. Direct test for `limit > maxResults` rejected as `invalid_input`. Assert binary-search byte-cap converges within O(log n) JSON serializations.
- **POST request fidelity**: spy on `fetch`, assert it was called with `method: 'POST'`, the short URL (no filter query string), `Content-Type: application/x-www-form-urlencoded`, and the expected body string. Also assert `data.request_body_params` matches, `data.logical_request_url` reproduces the request when re-issued as GET, and `provenance.source_url === data.logical_request_url`.
- Resource read tests for `idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata`:
  - Malformed/missing/repeated/array-typed values for each segment → JSON-RPC error (matching `tests/mcp/server.test.ts:174`), no upstream fetch, no `isError` content envelope, no `data: null` body.
  - Ordinary metadata returns `IdescatTableMetadata` with `degradation === undefined`.
  - Large geo metadata triggers ladder step 1 (categories dropped for the geo dimension only) with a geo-aware hint.
  - Large non-geo metadata triggers ladder step 1 with a hint that does NOT mention `idescat_list_table_geos`.
  - Stress fixture exceeding even the all-categories-dropped step → `IdescatError('invalid_response', ...)` surfaced as a JSON-RPC error.
- **Search-ranking tests use injected fixtures** (per "Search Ranking Tests Use Injected Fixtures"); module-loading tests are minimal.
- Status-from-dimension fixture: `dimension.YEAR.extension.status = { '2022': 'p' }` and `extension.status.label = { p: { label: 'provisional' } }`. Assert every row with `YEAR=2022` has `status: { code: 'p', label: 'provisional' }`.
- **Index staleness** test: a fixture with `generatedAt` 400 days in the past triggers `index_stale` via the project logger; `LOG_LEVEL=silent` suppresses output.
- MCP tests: tool registration, all tool input/output schemas (via `createIdescatSchemas(config)`), JSON text fallback, structured errors with `source_error` (Socrata + IDESCAT), prompt text for `idescat_query_workflow` and `idescat_citation` (including the explicit "call metadata before citation" instruction), resource reads, updated about-resource text. **No `dist/`-based assertions in Vitest.**
- `scripts/smoke.mjs` assertions (after `npm run build`): tools list includes the IDESCAT set; `listPrompts()` includes `idescat_query_workflow` and `idescat_citation`; `listResourceTemplates()` includes the IDESCAT template; declaration / source size guards.
- Add fixtures under `tests/fixtures/idescat/`; avoid live calls in normal tests.
- Use `createTestConfig(overrides?)` everywhere a literal `AppConfig` is needed.

## Assumptions / Defaults
- The first slice does not add generic `search` / `fetch` compatibility tools or a shared `SourceAdapter`; it stays source-native.
- Search uses the committed generated indices (one per language); runtime crawling is not part of normal request handling.
- IDESCAT data tools are for bounded extracts. `limit` only caps returned rows in the MCP response; there is no fake pagination over flattened cells.
- No metadata cache and no pre-flight cell-count rejection in this slice. Upstream HTTP 416 / internal `05` is the single source of truth for cell-limit overflow, mapped to `narrow_filters`.
- `geo_candidates` ships as `null`; clients always call `idescat_list_table_geos` to discover geo IDs.
- IDESCAT API terms are surfaced through dataset metadata only — `SourceOperationProvenance.license_or_terms` stays `null` for search/list, and prompts/README instruct callers to invoke metadata before citation.
