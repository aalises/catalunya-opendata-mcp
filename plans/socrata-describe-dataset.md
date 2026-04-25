# Socrata Describe Dataset

## Summary

- Add `socrata_describe_dataset` as the bridge between catalog search results and future query tooling.
- Fetch Socrata view metadata from `https://analisi.transparenciacatalunya.cat/api/views/{source_id}`.
- Return enough schema detail for callers to choose valid SODA API field names before query tooling exists.

## Key Changes

- Refactor `src/sources/socrata/client.ts` to expose a generic `fetchSocrataJson(url, config, options)` helper and rename catalog-specific error exports to generic Socrata names: `SocrataCatalogError` → `SocrataError`, `SocrataCatalogErrorCode` → `SocrataErrorCode`, and `isSocrataCatalogError` → `isSocrataError`. Preserve the existing error codes and retryability semantics. Catalog code switches to the renamed types; describe reuses the same helper. This avoids duplicating the fetch/timeout/abort wrapper and prevents misleading "Catalog" names on non-catalog endpoints.
- Add `src/sources/socrata/dataset.ts` with `describeSocrataDataset(input, config, options)` built on `fetchSocrataJson`.
- Reuse the existing client patterns: native `fetch`, timeout and caller cancellation, identifiable `User-Agent`, optional `X-App-Token`, typed `SocrataError`.
- Map top-level view metadata into:
  - `title` from `name`
  - `description` (null if absent or empty string)
  - `attribution` from `attribution`, `attribution_link` from `attributionLink`
  - `license_or_terms` — prefer `license.name`, fall back to `licenseId` only when no `license` object is present, and treat the literal `"SEE_TERMS_OF_USE"` as null since it conveys no information beyond the `attribution_link`
  - `created_at` from `createdAt`, `published_at` from `publicationDate`, `rows_updated_at` from `rowsUpdatedAt`, `view_last_modified` from `viewLastModified`. Drop the previously planned `metadata_updated_at` — that field is not present on `/api/views/{id}` (top-level `metadata` is only `{availableDisplayTypes, custom_fields}`).
  - `category` (passthrough when present)
  - `web_url`
  - `api_endpoint`
  - `columns`
  - dataset-level `provenance`
  - `suggested_next_action`
- Map each Socrata column into:
  - `display_name` from `name`
  - `field_name` from `fieldName`
  - `datatype` from `dataTypeName` (intentionally omit `renderTypeName` for v1; revisit if callers need to distinguish `number` vs `money`/`percent`)
  - `description` — normalize empty string to `null`
- Synthesize `web_url` as `https://analisi.transparenciacatalunya.cat/d/{source_id}`.
- Synthesize `api_endpoint` as `https://analisi.transparenciacatalunya.cat/resource/{source_id}.json`.
- For dataset-level `provenance.last_updated`, use the first non-null timestamp from this fallback chain: `rowsUpdatedAt` → `viewLastModified` → `publicationDate` → `createdAt`. If all are missing, set to `null` and widen `SocrataDatasetProvenance.last_updated` to `string | null`. Update the search adapter, MCP dataset provenance output schema (`z.string().nullable()`), and tests for the widened shape; current search values continue to be non-null in practice.
- Register MCP tool `socrata_describe_dataset` in `src/mcp/server.ts` with input `{ source_id }`, structured output, compact JSON text fallback, and the same error response style as search.
- `suggested_next_action` should be tool-name-agnostic: phrase as "use the returned `field_name` values to build SODA `$select`/`$where`/`$order` filters against `api_endpoint`" rather than referencing any future tool name.
- Update `README.md` with the search-to-describe workflow: search datasets, copy `source_id`, describe the dataset, then use returned field names against `api_endpoint`.

## Public Interface

- New MCP tool: `socrata_describe_dataset`.
- Input:
  - `source_id`: Socrata dataset identifier, validated as a four-by-four ID matching `/^[a-z0-9]{4}-[a-z0-9]{4}$/` (e.g. `v8i4-fa4q`). This is a new boundary check the search adapter does not perform.
- Output shape:

```ts
{
  data: {
    title: string;
    description: string | null;
    attribution: string | null;
    attribution_link: string | null;
    license_or_terms: string | null;
    category: string | null;
    source_id: string;
    source_domain: string;
    web_url: string;
    api_endpoint: string;
    created_at: string | null;
    published_at: string | null;
    rows_updated_at: string | null;
    view_last_modified: string | null;
    columns: Array<{
      display_name: string;
      field_name: string;
      datatype: string;
      description: string | null;
    }>;
    suggested_next_action: string;
    provenance: SocrataDatasetProvenance;
  } | null;
  provenance: SocrataOperationProvenance;
  error?: {
    source: "socrata";
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
  };
}
```

## Tests

- Add mocked HTTP tests for `describeSocrataDataset`. Cover:
  - request URL construction (`/api/views/{id}` against `analisi.transparenciacatalunya.cat`), headers, optional `X-App-Token`
  - success mapping with `license` object present (uses `license.name`)
  - fallback when only `licenseId` is present (uses `licenseId`)
  - `licenseId === "SEE_TERMS_OF_USE"` with no `license` object (maps to `null`)
  - column mapping including `description: ""` → `null`
  - epoch-second to ISO conversion for all four timestamps
  - `last_updated` fallback chain (`rowsUpdatedAt` missing → falls through to `viewLastModified`/`publicationDate`/`createdAt`; all missing → `null`)
  - passthrough fields (`category`, `attribution`, `attribution_link`) emitted when present and `null` when the source key is absent or empty
  - 404 from a non-existent ID surfaces as `http_error` with `status: 404` and `retryable: false`
  - invalid response body, network errors, and timeout-like aborts
- Add MCP `InMemoryTransport` tests covering tool registration, successful tool calls, structured output, compact JSON text fallback, malformed `source_id` validation (rejects e.g. `"abc"`, `"v8i4_fa4q"`, uppercase, embedded path segments), and error responses.
- Update existing search-adapter and MCP search tests for the widened `SocrataDatasetProvenance.last_updated` shape and the renamed `SocrataError`, `SocrataErrorCode`, and `isSocrataError` exports.
- Add a regression-guard assertion in the search-adapter test that `provenance.last_updated` is a non-null string for a representative catalog response, so the type-only widening cannot mask a runtime regression where the value silently becomes `null`.
- Run `npm run typecheck`, `npm test`, and `npm run smoke` after implementation.

## Assumptions

- Outputs continue to use snake_case, matching `socrata_search_datasets`.
- `language` remains fixed to `ca` for this Generalitat Socrata slice.
- Socrata epoch-second timestamps are converted to ISO strings.
- `source_domain` is hardcoded to `analisi.transparenciacatalunya.cat` for this slice; `source_id` values surfaced from search against other federation domains would yield wrong synthesized URLs. This is acceptable today because search itself is domain-pinned, and is documented in the assumption.
- The tool only describes Socrata datasets. Query execution remains out of scope until a later query slice; the tool's `suggested_next_action` therefore points to SODA conventions, not a tool name.

## Revision history

### Round 1 — self-critique against live API response

Verified the plan against an actual response from `https://analisi.transparenciacatalunya.cat/api/views/v8i4-fa4q` and against `src/sources/socrata/{client.ts,catalog.ts}`.

- **Removed `metadata_updated_at`.** Field does not exist on `/api/views/{id}`; top-level `metadata` is only `{availableDisplayTypes, custom_fields}`. Replaced with `view_last_modified` sourced from `viewLastModified`.
- **Replaced `publisher` with `attribution` + `attribution_link`.** The view endpoint does not expose a `publisher` field; `attribution` and `attributionLink` are the available signals.
- **Reworked license mapping.** Plan previously said "`licenseId` is sufficient." In practice `licenseId` is an opaque enum (e.g. `"SEE_TERMS_OF_USE"`); the human-readable name lives in the `license` object (`{name: "See Terms of Use"}`). New rule: prefer `license.name`, fall back to `licenseId`, treat `SEE_TERMS_OF_USE` as null when no `license` object is present.
- **Added `last_updated` fallback chain.** `SocrataDatasetProvenance.last_updated` was non-nullable, but `rowsUpdatedAt` can be missing for datasets that never had row updates. Widened the type and MCP output schema to `string | null` and specified the fallback chain (`rowsUpdatedAt` → `viewLastModified` → `publicationDate` → `createdAt` → `null`). Search adapter and its tests also update for the widened shape.
- **Renamed catalog-specific error exports and extracted `fetchSocrataJson`.** The `/api/views/{id}` endpoint is not the catalog; reusing the "Catalog" name would mislead, and duplicating the fetch wrapper would drift. Refactor `client.ts` to expose a generic JSON helper used by both adapters, with `SocrataError`, `SocrataErrorCode`, and `isSocrataError` replacing the catalog-specific names.
- **Normalized empty column descriptions to `null`.** Real responses sometimes return `""` instead of omitting the key.
- **Reworded `suggested_next_action` to be tool-name-agnostic.** Previous wording referenced a future `socrata_query_dataset` tool name; baking that into responses today creates churn if the tool is renamed or split. New wording points to SODA `$select`/`$where`/`$order` against `api_endpoint`.
- **Made `source_id` validation explicit.** Plan now specifies the regex `^[a-z0-9]{4}-[a-z0-9]{4}$` and notes this is a new boundary check the search adapter does not perform.
- **Documented `dataTypeName`-only mapping as a deliberate v1 omission.** `renderTypeName` distinguishes `number` from `money`/`percent`; revisit if callers need it.
- **Documented `source_domain` hardcoding** as a known constraint that aligns with the domain-pinned search adapter.

### Round 2 — test coverage gaps

- **Added explicit test coverage for `category`, `attribution`, and `attribution_link` passthrough.** These fields are in the output shape but had no corresponding test bullet; assertion now covers both "present on source" and "absent or empty → null" cases.
- **Added a regression-guard assertion in the search-adapter test for `provenance.last_updated`.** With the type widened to `string | null`, a runtime regression that silently produces `null` for catalog responses would type-check cleanly. Pinning the asserted value as a non-null string for a representative response keeps the search-side behavior load-bearing.
