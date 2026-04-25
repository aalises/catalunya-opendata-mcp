# Socrata Metadata Resource And Citation Prompt

## Summary

Add one read-only MCP resource template for Socrata dataset metadata and one lightweight citation prompt. The resource reuses the existing describe adapter and returns the metadata artifact itself, while the prompt helps humans format citations from either `socrata_describe_dataset` output or the metadata resource.

## Key Changes

- Register `socrata://datasets/{source_id}/metadata` as an MCP resource template with `application/json`.
- Resource body is compact JSON of `SocrataDescribeDatasetResult.data` only, not the `{ data, provenance, error? }` tool envelope. Add a short code comment near registration explaining the deliberate shape difference.
- Reuse existing `normalizeSourceId()` from `src/sources/socrata/client.ts`; do not add a new `isValidSocrataSourceId()` helper.
- Defensively coerce template variables: reject missing or array-valued `source_id`, then normalize before fetching so malformed IDs fail without network access.
- Reuse `describeSocrataDataset({ source_id }, config, { signal: extra.signal })` and serialize the returned `.data`.
- Resource errors should throw, not return an error envelope. Re-throw `SocrataError` unchanged; let unexpected errors propagate through the SDK as JSON-RPC errors.
- Add one zero-argument MCP prompt, `socrata_citation`, as a fill-in-the-blank citation template. It should reference `title`, `web_url`, `provenance.source_url` as fallback, `attribution`, `attribution_link`, `rows_updated_at` with `view_last_modified` fallback, `license_or_terms`, and `source_domain`.

## Public Interface

- New resource template:
  - `socrata://datasets/{source_id}/metadata`
- New prompt:
  - `socrata_citation`
- Existing tools and query behavior remain unchanged.

## Test Plan

- In-memory MCP test: `client.listResourceTemplates()` includes `socrata://datasets/{source_id}/metadata` with `mimeType: "application/json"`.
- In-memory MCP test: reading `socrata://datasets/v8i4-fa4q/metadata` with mocked Socrata describe response returns JSON containing `source_id`, `columns[]` with `field_name`, and dataset-level `provenance`.
- In-memory MCP test: malformed `source_id` rejects and does not call `fetch`.
- In-memory MCP test: upstream 404 rejects as an MCP/JSON-RPC error and is not returned as an `{ error }` resource payload.
- In-memory MCP test: `client.listPrompts()` includes `socrata_citation`, and `client.getPrompt({ name: "socrata_citation" })` returns at least one non-empty text message.
- Avoid brittle prompt wording assertions.

## Verification

Run:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run smoke`

`npm run smoke` only exercises `ping` today; resource and prompt behavior are covered by the in-memory tests.

## Assumptions

- MCP resource consumers want the metadata artifact itself, not a tool-call envelope.
- Existing `normalizeSourceId()` is the canonical source ID validator.
- No caching, subscriptions, citation tool, runtime column validation, or query behavior changes are included in this slice.
