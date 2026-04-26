# Plan: Complete IDESCAT Polish + Refresh Crawler

## Summary
Implement the remaining IDESCAT hardening work as one batch: add focused tests for request building, caps, degradation, JSON-safe output, and stale search-index logging; then replace the placeholder `refresh:idescat` script with a real paced crawler that regenerates the committed search index. This will change no MCP tool names or user-facing request shapes.

## Key Changes
- Add focused tests:
  - `request.test.ts`: GET/POST boundary, canonical filter ordering, actual vs logical request URL, POST body params.
  - `metadata-degradation.test.ts`: metadata category/link/note/extension degradation, including geo-aware hint.
  - `list-cap.test.ts`: byte-cap truncation on list tools with synthetic high-cardinality collections.
  - `json-safe.test.ts`: `BigInt`, `Error`, `URL`, circular refs, functions, class instances, and `createJsonTextContent` safety.
  - `search.test.ts`: stale-index logger warning coverage.
- Make all filter-cap rules testable:
  - Preserve existing rule payload shape: `source_error: { rule, observed, limit }`.
  - Cover `filter_count`, `filter_key_bytes`, `filter_value_bytes`, `filter_total_bytes`, `logical_url_bytes`, and `post_body_bytes`.
  - To make `post_body_bytes` reachable, update POST request validation order: once canonical URL length is above the POST threshold, validate POST body size before logical URL size. Keep `logical_url_bytes` testable with a body below 16 KiB but URL above 8 KiB.
- Replace `scripts/refresh-idescat.ts`:
  - Crawl `ca`, `es`, `en`.
  - Sequence: statistics → nodes → tables.
  - Sequential requests with default 250ms pacing.
  - Retry 429/5xx/network errors up to 4 times with exponential backoff and jitter.
  - Skip geos in this pass; `geo_candidates` remains `null`.
- Generate stable index files:
  - Flat files: `search-index/{lang}.ts` when each generated source stays ≤ 1 MiB.
  - Sharded files: `search-index/{lang}/{statistics_id}.ts` plus `search-index/{lang}/index.ts` when flat output exceeds 1 MiB.
  - When sharded, the top-level `search-index/{lang}.ts` becomes a re-export shim of the same named exports (`default`, `generatedAt`, `indexVersion`, `sourceCollectionUrls`), so `src/sources/idescat/search.ts` does not change.
  - Sort entries by `statistics_id`, `node_id`, `table_id`; include `generatedAt`, `indexVersion`, and root `sourceCollectionUrls`.
- Keep smoke size guards, updating them only where sharded paths require broader checks.

## Test Plan
- Unit tests for request building:
  - URL byte length exactly `<= 2000` stays GET.
  - URL byte length `> 2000` becomes POST.
  - POST keeps filters in `request_body_params`, keeps `lang` and `_LAST_` in URL, and preserves `logical_request_url`.
  - Canonical filter key ordering uses code-point order.
- Unit tests for cap errors:
  - Each cap produces `IdescatError("invalid_input")`.
  - Each cap includes exact `source_error.rule`, `observed`, and `limit`.
- Unit tests for refresh generation:
  - Mocked collection crawl produces expected entries.
  - Relative and absolute hrefs are parsed correctly.
  - Empty languages still generate valid modules.
  - Flat-vs-sharded threshold is deterministic.
  - Retry/backoff decisions are tested with injected fetch/sleep helpers.
- Existing MCP/server tests remain green.
- Final verification:
  - `npm run check`
  - `npm run refresh:idescat`
  - inspect generated diff for size/readability
  - `npm run check` again
  - run the live MCP IDESCAT test over stdio.

## Assumptions
- The latest request supersedes the earlier "keep `post_body_bytes` unreachable" preference; implementation should make `post_body_bytes` reachable via validation order only.
- `refresh:idescat` is a manual maintainer command, not part of CI.
- The crawler does not resolve geos per table in this batch.
- Generated index content is committed after refresh.
