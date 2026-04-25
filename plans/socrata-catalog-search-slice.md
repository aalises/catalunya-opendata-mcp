# Socrata Catalog Search Slice

## Summary

- Add the first concrete source slice for Socrata catalog search only; no generic adapter layer or shared `sources/common` types yet.
- Use Socrata catalog v1/Discovery API, not `data.json`, for queryable search.
- Search the EU Socrata federation hub at `https://api.eu.socrata.com/api/catalog/v1` with hardcoded `domains=analisi.transparenciacatalunya.cat` and `only=dataset`.

## Key Changes

- Add `src/sources/socrata/client.ts` with native `fetch`, `AbortSignal.timeout`, optional caller cancellation via `AbortSignal.any`, identifiable `User-Agent`, optional `X-App-Token`, catalog URL construction, and Socrata-local errors.
- Add `src/sources/socrata/catalog.ts` with local response schemas, dataset-card mapping, offset pagination, total result count, nullable descriptions, and synthesized SODA API endpoints.
- Build the catalog URL once per search and reuse it for both the upstream request and operation provenance.
- Register MCP tool `socrata_search_datasets` with title `socrata.search_datasets`, config-based limit validation, structured output, compact JSON text fallback, and no workflow hints for tools that do not exist yet.
- Keep operation provenance and item provenance distinct when these shapes are eventually promoted; the search operation has no single update timestamp, while each dataset card does.

## Tests

- Mock `globalThis.fetch` with Vitest for Socrata source tests.
- Cover URL/header construction, success mapping, null license handling, nullable descriptions, required `updatedAt`, cancellation-signal wiring, HTTP errors, network errors, and timeout-like aborts.
- Use SDK `InMemoryTransport` for MCP tests covering tool registration, successful tool calls, JSON fallback, and config-based limit validation without asserting on SDK-owned error text.

## Assumptions

- Outputs use snake_case; inputs use short identifiers such as `query`, `limit`, and `offset`.
- `language` is fixed to `ca` for this first Generalitat Socrata slice.
- `api_endpoint` is synthesized as the stable SODA endpoint because catalog links are human-facing portal URLs.
- `socrata_describe_dataset` and DCAT indexing are left for later.
