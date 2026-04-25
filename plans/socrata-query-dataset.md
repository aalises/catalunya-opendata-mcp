# Socrata Query Dataset

## Summary

Add `socrata_query_dataset` as the next thin Socrata tool: callers provide a dataset `source_id` plus optional raw SODA clauses (`$select`, `$where`, `$group`, `$order`), and the server fetches rows from `https://analisi.transparenciacatalunya.cat/resource/{source_id}.json`.

Use the trust-Socrata path for SoQL syntax: do not parse or locally validate clauses. Apply only defensive byte/length caps so we fail fast as `invalid_input` instead of producing 414s or unbounded allocations. Surface bounded Socrata error response bodies in tool errors so callers can self-correct. Apply server-side response caps (rows + bytes) per `specs.md:149-170` so a wide dataset cannot blow up `structuredContent`.

## Key Changes

- Extract `SOCRATA_SOURCE_ID_PATTERN` and a `normalizeSourceId(input): string` helper out of `src/sources/socrata/dataset.ts` into `src/sources/socrata/client.ts` (or a new `source-id.ts`) so describe and query share validation without query taking a runtime dependency on the metadata adapter.
- Add a Socrata query adapter (`src/sources/socrata/query.ts`) that builds SODA resource URLs with `$select`, `$where`, `$group`, `$order`, `$limit`, and `$offset`; reuses the shared fetch helper, timeout handling, and app token header.
  - Reject any clause whose trimmed length exceeds `SOCRATA_QUERY_CLAUSE_MAX_BYTES` (4096 bytes after UTF-8 encoding) and any built URL whose total length exceeds `SOCRATA_QUERY_URL_MAX_BYTES` (8192 bytes) before fetching, throwing `SocrataError("invalid_input", ...)`.
  - Use a `limit + 1` sentinel: request `limit + 1` rows from Socrata, then return at most `limit` rows. Set `truncated: true` (with `truncation_reason: "row_cap"`) only when the sentinel row was returned. This eliminates the false-positive truncation when a result set exactly matches `limit`.
  - `$group` is included as an optional pass-through clause for aggregate workflows. We do not parse it; we apply the same trim, byte-cap, and URL-cap rules. The tool does not auto-inject `:id` ordering (per `specs.md:208`, default ordering must not be injected when the query is aggregate, and we cannot detect that without parsing `$select`/`$group`).
- Server-side response caps applied after parsing the upstream JSON, before constructing `structuredContent`. Scope note: these caps protect the MCP output envelope, not the upstream parse step; `fetchSocrataJson` still calls `response.json()` on the success path. Adding a body-byte cap to the shared fetch helper for query responses is tracked as a follow-up so a malicious or runaway upstream body cannot allocate without bound.
  - `row_cap`: enforced via the `limit + 1` sentinel above.
  - `byte_cap`: measure the candidate full success envelope `{ data, provenance }` (the same object that becomes `structuredContent`) via `Buffer.byteLength(JSON.stringify(envelope), "utf8")`. If it exceeds `SOCRATA_QUERY_RESPONSE_MAX_BYTES` (256 KiB default, configurable via `CATALUNYA_MCP_RESPONSE_MAX_BYTES` up to a hard ceiling of 1 MiB), pop rows from the tail and re-measure until the envelope fits, set `truncated: true`, and set `truncation_reason: "byte_cap"`. If even the empty-rows envelope exceeds the cap (pathological — e.g., `select` produced gigantic synthetic columns), the adapter throws `SocrataError("invalid_response", "Socrata response envelope exceeds response cap even after dropping all rows.")`; the MCP handler wraps it into `{ data: null, provenance, error }` per the existing pattern. The adapter never returns a tool-shaped envelope directly.
  - Truncation precedence: if both caps apply (sentinel proves more rows exist *and* byte cap also dropped rows), surface `truncation_reason: "byte_cap"` because it is the more actionable signal — raising `limit` would not help. `row_cap` is reported only when the sentinel triggered and the byte cap did not pop any further rows. Pin precedence with a test.
  - `row_count` is always `rows.length` after all truncation, so the output is internally consistent.
  - Add a `truncation_hint` string when truncated (`"narrow filters / reduce $select / paginate"` per `specs.md:167`).
- Register MCP tool `socrata_query_dataset` with input `{ source_id, select?, where?, group?, order?, limit?, offset? }`.
  - Validation contract is split cleanly:
    - Zod input schema enforces only JSON-level types: `source_id: z.string()`, optional clause fields `z.string()`, `limit: z.number().optional()`, `offset: z.number().optional()`. No `int()`, `min`, `max`, or regex in Zod. `limit: "10"` is rejected by Zod (SDK-level), not by the adapter.
    - The adapter enforces format and ranges and produces structured Socrata errors via `toSocrataToolError`: `source_id` regex; `limit` must satisfy `Number.isSafeInteger` and lie in `[1, config.maxResults]`; `offset` must satisfy `Number.isSafeInteger` and be `>= 0`; clauses are within byte caps; full URL is within byte cap. `limit: 1.5`, `limit: 0`, `limit: 1e21`, `offset: -1`, `offset: 1e21`, malformed `source_id`, and oversize clauses all map to `code: "invalid_input"`, `retryable: false`. `Number.isSafeInteger` is used (not just `Number.isInteger`) so direct adapter callers cannot smuggle imprecise or scientific-notation values past range checks.
  - Default `limit` to `Math.min(100, config.maxResults)`, default `offset` to `0`.
- Tool description must steer LLM clients explicitly. The `registerTool` `description` for `socrata_query_dataset` includes, in this order:
  1. Always call `socrata_describe_dataset` first and use returned `field_name` values (not `display_name`).
  2. Pass clause *values* only (e.g. `where: "municipi = 'Girona'"`), never `?$where=...` fragments.
  3. Supply `order` whenever using `offset` for stable pagination; without it, repeated calls may return duplicate or missing rows.
  4. Prefer narrowing filters or reducing `$select` over raising `limit`. Server caps row count and response bytes; the response signals truncation explicitly.
  5. Aggregate queries combine `select` (with aggregate functions) and `group`.
- Specify the rows schema explicitly: `rows: Array<Record<string, JsonValue>>` where `JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }`. Represent in MCP `outputSchema` as `z.array(z.record(z.unknown()))`. Non-object array elements from upstream cause `invalid_response`.
- Lock down optional clause output contract: `select`, `where`, `group`, `order` are present in `data` only when supplied (omit when absent after trim). Tests pin this.
- Provenance helpers and error-path safety:
  - Add `createSocrataQueryProvenance(input, requestUrl?)` mirroring `createSocrataDescribeProvenance` (`src/sources/socrata/dataset.ts:116-135`). When the input cannot produce a safe request URL (invalid `source_id`, oversize clauses, oversize URL), the helper falls back to `https://${SOCRATA_CATALOG_DOMAIN}/` so the MCP catch block in `src/mcp/server.ts` never throws while building provenance. Operation provenance uses `id: "analisi.transparenciacatalunya.cat:dataset_query"`, `last_updated: null`, `license_or_terms: null`, `language: "ca"`.
  - On the success path, `request_url` and `provenance.source_url` equal the actual upstream URL, including the `$limit = limit + 1` sentinel. `logical_request_url` is also returned with the caller-visible `$limit = limit`, so clients have a stable URL matching the visible row cap.
- Update Socrata HTTP error handling in `src/sources/socrata/client.ts:createHttpError` to append a bounded body excerpt (max 2000 chars) for *all* non-2xx responses:
  - Read the body via `response.body.getReader()` and stop at `SOCRATA_ERROR_BODY_MAX_BYTES` (4096 bytes), then decode with `TextDecoder` and truncate to 2000 characters with an ellipsis suffix. Never call `await response.text()` on an unbounded body.
  - If `response.body` is `null`, keep the original HTTP message with no excerpt.
  - If the body read or decode throws, swallow it and keep the original message. The original `status` and `code` are preserved unconditionally. No logging is added in this slice (no logger abstraction exists yet despite `LOG_LEVEL` being parsed in `src/config.ts:23-42`); logging is tracked as a follow-up.
  - Whitespace-collapse JSON or HTML bodies to a single line before truncation.
  - This is a cross-tool contract change: search and describe error messages will now also include excerpts. Existing tests at `tests/mcp/server.test.ts:212` and `tests/sources/socrata/*.test.ts` only assert on `code`/`status`/partial messages, so they should keep passing; this slice treats the change as intentional.
- Keep the query JSON text fallback simple: `content[0].text` remains `JSON.stringify(structuredContent)` because the structured success envelope is already capped by `responseMaxBytes`. Search/describe keep their existing duplication.
- Configuration plumbing:
  - Add `CATALUNYA_MCP_RESPONSE_MAX_BYTES` to `src/config.ts` with `z.coerce.number().int().min(32_768).max(1_048_576).default(262_144)` and expose it on `AppConfig` as `responseMaxBytes`. The query adapter reads it from `AppConfig`; nothing reads `process.env` directly. The 32 KiB minimum stays comfortably above the 8192-byte URL cap plus the fixed envelope overhead.
  - Update `.env.example` with the new key and a one-line description.
  - Update `tests/config.test.ts` to assert default, override, and out-of-range rejection for the new env var.
  - Update every `AppConfig` test fixture (`tests/mcp/server.test.ts`, any future fixture in `tests/sources/socrata/*.test.ts`) to include `responseMaxBytes`.
- Documentation:
  - Replace the stale "repository starts intentionally small..." line at `README.md:5` and update the `about` resource text in `src/mcp/server.ts:183`. Add `socrata_query_dataset` to the "Current MCP surface" list and document the `search -> describe -> query` flow including `field_name` usage, `order`-for-pagination guidance, and aggregate (`group` + `select` aggregates) examples.

## Public Interface

- New MCP tool: `socrata_query_dataset`.
- Inputs:
  - `source_id`: string. Type-validated in Zod; format-validated (`^[a-z0-9]{4}-[a-z0-9]{4}$`) in the adapter.
  - `select`, `where`, `group`, `order`: optional strings. Type-only in Zod. Adapter trims, omits when empty after trim, enforces 4096-byte per-clause cap and 8192-byte total URL cap.
  - `limit`: optional number; type-only in Zod. Adapter requires integer in `[1, config.maxResults]`. Default `Math.min(100, config.maxResults)`.
  - `offset`: optional number; type-only in Zod. Adapter requires non-negative integer. Default `0`.
- Output:
  - `data: { source_id, source_domain, api_endpoint, request_url, logical_request_url, limit, offset, row_count, truncated, truncation_reason?, truncation_hint?, rows, select?, where?, group?, order? } | null`
    - `request_url` is the actual upstream URL, including the `$limit = limit + 1` sentinel. `logical_request_url` uses the caller-visible `$limit = limit`.
    - `truncation_reason` is `"row_cap" | "byte_cap"` for this tool. Present only when `truncated === true`; timeouts remain tool errors, not partial success responses.
    - `truncation_hint` is present only when `truncated === true`.
  - `provenance`: source `"socrata"`, language `"ca"`, `source_url` equal to the actual `request_url` on success or `https://analisi.transparenciacatalunya.cat/` on pre-request failures, `id: "analisi.transparenciacatalunya.cat:dataset_query"`, `last_updated: null`, `license_or_terms: null`.
  - `error`: existing Socrata tool error shape, with upstream response body excerpt included in `message` when available. `invalid_input` is now reachable for malformed `source_id`, non-integer or out-of-range `limit`/`offset`, oversize clauses, and oversize URL.

## Test Plan

- Adapter tests (mocked):
  - URL/query-param construction with all clauses, with subsets, and with no optional clauses; `$group` is present iff supplied.
  - Trimming and omission of empty/whitespace-only clauses (including verifying `data.select` etc. are *absent* in the output, not `null` or empty string).
  - `limit + 1` sentinel: result-set sizes `< limit`, `== limit`, and `> limit` produce `truncated` `false`, `false`, `true` respectively, with rows sliced to `limit` and `truncation_reason: "row_cap"` only on the `> limit` case.
  - Byte-cap truncation: stub a response large enough to exceed `responseMaxBytes`; assert rows are dropped from the tail, `truncated: true`, `truncation_reason: "byte_cap"`, `row_count === rows.length` after truncation, and final envelope size is within cap. Pathological case where the empty-rows envelope already exceeds the cap throws `SocrataError("invalid_response", ...)` from the adapter; MCP wraps it into `data: null` + structured error.
  - Truncation precedence: stub a response that is both larger than `limit` (sentinel triggers) *and* exceeds the byte cap after sentinel slicing. Assert `truncation_reason: "byte_cap"` (not `"row_cap"`). Mirror test for sentinel-only triggers `"row_cap"` and for under-cap responses `truncated: false` with no `truncation_reason`.
  - `request_url` and `provenance.source_url` reflect the actual sentinel `$limit = limit + 1`; `logical_request_url` reflects the caller-visible `$limit = limit`.
  - Limit defaulting (with and without `config.maxResults` smaller than 100); `limit > maxResults` -> `invalid_input`; `limit < 1` -> `invalid_input`; non-integer `limit`/`offset` -> `invalid_input`; `offset < 0` -> `invalid_input`; `limit: 1e21` and `offset: 1e21` -> `invalid_input` via `Number.isSafeInteger`.
  - Per-clause and total-URL byte-cap rejections.
  - Invalid `source_id` -> `invalid_input` from the adapter (not Zod). MCP-layer test verifies the structured Socrata error reaches the client.
  - Provenance fallback: with malformed `source_id` or oversize URL inputs, `createSocrataQueryProvenance` returns domain-root provenance and does not throw.
  - Non-array JSON body -> `invalid_response`. Array containing non-object element -> `invalid_response`. Rows with `null`, nested objects, arrays, and location-shaped values pass through unchanged.
  - HTTP errors (400, 404, 414, 429, 500), network errors, timeout errors.
- Client (`fetchSocrataJson`) regression tests:
  - Body excerpt is appended to `SocrataError.message` for 400, 414, 500, 429 responses (sample asserted).
  - Null body and body read failure: both keep the original HTTP status and code, and produce no body-excerpt suffix.
  - Bodies larger than 4096 bytes are truncated without buffering the full body. Test fake provides chunks summing well above the cap and asserts `read()` is not driven past the cap.
  - Whitespace and newline collapsing in excerpts.
  - 5xx and 429 statuses include excerpts; `retryable` semantics preserved.
- MCP tests:
  - Register and call `socrata_query_dataset`; verify structured output and JSON text fallback.
  - Validation split: assert SDK-level rejection of `limit: "10"` (Zod type error, `isError: true`, no Socrata error shape required) versus adapter-level structured error for `limit: 99999`, `limit: 1.5`, `limit: 0`, `limit: 1e21`, `offset: -1`, `offset: 1e21`, malformed `source_id`. Each adapter case sets `structuredContent.error.code === "invalid_input"` and `structuredContent.error.source === "socrata"` and the handler does not throw.
  - Mocked `search -> describe -> query` workflow including an aggregate query path that uses `group`.
  - Tool description is registered with the workflow guidance points (assert by snapshot of the description string).
- Smoke / e2e:
  - Update `scripts/smoke.mjs` and `tests/e2e/smoke.test.ts` to assert all four public tools (`ping`, `socrata_search_datasets`, `socrata_describe_dataset`, `socrata_query_dataset`).
- Run `npm run typecheck`, `npm test`, and `npm run smoke`.

## Assumptions

- Query execution is read-only and scoped to the hardcoded Generalitat Socrata domain.
- The query tool does not fetch metadata or validate column names itself; callers join `socrata_describe_dataset` results when they need attribution, license, or schema. Operation provenance keeps `last_updated`/`license_or_terms` as `null`, matching search and describe operation provenances.
- Socrata syntax errors are handled by upstream 4xx responses with body excerpts surfaced verbatim, not by a local SoQL parser.
- We do not auto-inject `:id` ordering on aggregate queries because we do not parse `$select`/`$group`. The tool description tells callers to supply `order` for paginated reads.
- Response caps (`row_cap`, `byte_cap`) match the `specs.md:149-170` defaults (500 row default, 256 KB byte default) but this slice uses `config.maxResults` (default 100) for the row default since that is the existing project knob; the byte cap is a new knob `CATALUNYA_MCP_RESPONSE_MAX_BYTES` with a 256 KiB default and 1 MiB hard ceiling.
- Cancellation via the MCP `extra.signal` continues to be reported as `code: "timeout", retryable: true` because `toFetchError` in `src/sources/socrata/client.ts:131` cannot distinguish caller abort from server timeout. Out of scope for this slice.
