# Plan: IDESCAT geo-aware discovery

## Summary

Make IDESCAT discovery understand geography words inside ordinary search queries, so users can ask for a topic and a territorial level in one phrase. The target journey is:

`idescat_search_tables("poblacio comarca")` -> result exposes `geo_candidates` including `com` -> `idescat_list_table_geos` confirms the selected `geo_id` -> metadata -> bounded data.

Keep the public MCP surface stable: no new tools, no input schema changes, no output schema changes, and no new error fields. Use the existing `geo_candidates` field on `idescat_search_tables` results; it is currently always `null`, so this slice turns dormant schema into useful guidance.

## Problem

IDESCAT table labels and node labels describe the statistical topic, while available territorial cuts are exposed one step later by `idescat_list_table_geos`. Current search AND-gates every query token against topic text, so geographic words often make valid topic searches empty:

- `poblacio comarca` returns no useful bridge even though PMH tables expose `geo_id: "com"`.
- `renda comarca`, `afiliacions comarca`, and similar queries force the client to guess that the geography word should be removed before search.
- `atur comarca` should no longer dead-end. If IDESCAT has a strong topic match with `com`, it should surface that table/geo. If the strongest real `atur` table only exposes `cat`, the result should make that clear through `geo_candidates` rather than promoting a weak substring match or pretending county data exists.

The last point matters because the existing substring matcher can match `atur` inside unrelated words such as `naturalesa`. Geo-aware ranking must not let a geography boost turn those weak substring hits into false positives.

## Product Behavior

1. Topic-only searches keep the current ranking behavior, aside from each result now carrying known `geo_candidates`.
2. Topic + geography searches split the query into topic terms and requested `geo_id`s:
   - `comarca`, `comarques`, `county`, `counties` -> `com`
   - `municipi`, `municipis`, `municipality`, `municipalities` -> `mun`
   - `provincia`, `provincies`, `province`, `provinces` -> `prov`
   - `catalunya`, `catalonia`, `cataluna` -> `cat`
   - `ambit territorial`, `ambits territorials`, `territorial area(s)` -> `at`
   - `districte`, `district` -> `dis`
   - `seccio censal`, `census section` -> `sec`
3. Search eligibility uses topic terms, not geography terms. Geography terms affect ranking and `geo_candidates`, but they do not make topic discovery empty. A row that fails topic eligibility (no `topicTokens` matched at all) stays ineligible and is filtered out, regardless of geography support — geo signals never resurrect a non-topic row.
4. A result that supports the requested geography gets a geo boost only when the topic match is strong enough: every topic term must match as an exact word or exact ID, not only as a substring inside a longer word.
5. If no strong topic candidate supports the requested geography, keep the strongest topic result first and expose its actual `geo_candidates`. The client should then call `idescat_list_table_geos` and explain the available territorial cuts instead of guessing.

## Scope

In scope:

- Add committed geography hints for each indexed IDESCAT table.
- Populate `idescat_search_tables.data.results[].geo_candidates` from those hints.
- Parse geography intent out of search queries without adding input fields.
- Adjust ranking so geography-aware queries prefer matching geos without weakening topic relevance.
- Update MCP tool/prompt wording to say search can recognize geography words and that `geo_candidates` still need confirmation with `idescat_list_table_geos`.
- Add deterministic unit tests and one live canary assertion for the full geo bridge.

Out of scope:

- New MCP tools, new prompt names, new resources, or new structured fields.
- Runtime live geo lookups inside `idescat_search_tables`; search should remain fast and mostly offline.
- Metadata/dimension semantic search beyond table geographies.
- Broad synonym expansion for statistical topics. A small topic synonym map can be considered later, but this slice should not try to make `atur` mean every possible unemployment-related label.
- Adjective forms of geography words (`municipal`, `comarcal`, `provincial`). A query like `nivell municipal` will treat `municipal` as a topic token, not a geo token. Recoverable later by extending the alias map; not addressed here.
- Specific named places (`atur Maresme`, `Barcelonès`). Resolving named comarques/municipis to specific geo dimension category IDs requires per-table category labels in the index, which is a separate (heavier) crawl. Out of scope.
- Socrata changes.

## Data Model

Extend the generated search index entry with optional geography hints:

```ts
export interface IdescatSearchIndexEntry {
  ancestor_labels: {
    node: string;
    statistic: string;
  };
  geo_ids?: string[];
  label: string;
  node_id: string;
  source_url: string;
  statistics_id: string;
  table_id: string;
}
```

`geo_ids` is optional so older synthetic fixtures can be migrated gradually, but the generated index should include it for every table after refresh.

The canonical geo-code set is verified against the live IDESCAT API (sample probe: `GET https://api.idescat.cat/taules/v2/pmh/1180/8078?lang=ca` returns `cat, prov, at, com, mun, dis, sec`):

```ts
const CANONICAL_GEO_ORDER = ["cat", "prov", "at", "com", "mun", "dis", "sec"] as const;
```

Two distinct orderings, kept distinct intentionally:

- **On disk (committed search-index files):** `geo_ids` are stored alphabetically sorted, for deterministic diffs across refreshes. Refresh writes `["at","cat","com","dis","mun","prov","sec"]`.
- **In `idescat_search_tables.data.results[].geo_candidates`:** entries are reordered at output time. When the query requested geographies, matching requested IDs come first (in the order they appeared in the query, deduped), followed by the remaining available IDs in `CANONICAL_GEO_ORDER`. When the query requested no geography, results use `CANONICAL_GEO_ORDER` directly. Unknown codes (forward-compatibility, in case IDESCAT adds new granularities) are appended after canonical ones, alphabetically.

Search output maps this to:

```ts
geo_candidates: entry.geo_ids?.length
  ? orderGeoCandidates(entry.geo_ids, requestedGeoIds)
  : null
```

`null` (not `[]`) is preserved when the entry has no `geo_ids` hint at all — distinguishes "we don't know" (older fixture, refresh hasn't been run) from "table genuinely supports no granularities" (which IDESCAT does not produce in practice).

## Refresh Pipeline

Update `scripts/refresh-idescat.ts`:

- After each table is discovered, fetch its geo collection URL (`/{statistics_id}/{node_id}/{table_id}?lang=…`) and extract `geo_id` values from each `link.item[].href`. **Reuse the existing parser**: the runtime path already does this in `src/sources/idescat/catalog.ts` via `listIdescatTableGeos` → `parseCollectionHref(item, [stat,node,table], 4, base)`. Refresh should call into the same parser (or an extracted helper sharing one implementation) rather than reimplementing path-segment slicing — drift between refresh and runtime parsing has previously broken alternate-geographies classification (see `metadata.ts:extractTupleFromUrl` history).
- Sort `geo_ids` alphabetically on the generated entry. (Output reordering happens at query time; see Data Model.)
- Share a `Map<string, string[]>` cache across languages, keyed by `${statistics_id}/${node_id}/${table_id}` (geo IDs are language-invariant — only the label of `Per comarques i Aran` vs `Per comarcas y Arán` vs `By counties and Aran` differs). A full `ca,en,es` refresh fetches table geos once per unique table rather than once per language.
- Reuse the existing fetcher pacing/retry/timeout behavior (`DEFAULT_PACE_MS`, `DEFAULT_MAX_RETRIES`, `DEFAULT_REQUEST_TIMEOUT_MS`) for geo collection fetches. No new tuning constants.
- Preserve generated file sharding (`DEFAULT_SHARD_THRESHOLD_BYTES`) and the `npm run package:size` guardrail.

Do not fetch metadata during refresh; table-collection geos are enough for discovery and keep the crawl bounded. Adding metadata would multiply request count by another factor of ~7 (one per geo per table) and is unnecessary for this slice.

## Query Analysis

Add a small helper module, likely `src/sources/idescat/search-geography.ts`, with:

- `analyzeIdescatDiscoveryQuery(query: string)` returning:
  - `topicTokens: string[]`
  - `requestedGeoIds: string[]`
  - `geoTokens: string[]`
- `orderGeoCandidates(available: readonly string[], requested: readonly string[])`.
- A normalized alias map using the existing `normalizeSearchTerm` behavior.

Rules:

- Match specific multi-token geography aliases before single-token aliases, e.g. `seccio censal` before `seccio`.
- Remove matched geography tokens from the topic token list.
- If the query is only geography, return no ranked results rather than listing every table with that geography.
- Deduplicate requested geos while preserving query order.

## Ranking

Refactor `rankIdescatSearchResults` so it can score topic relevance and geography relevance separately.

Topic scoring:

- Preserve the existing scoring and canonical statistic priority for topic-only queries.
- Use only `topicTokens` for eligibility and topic score when geography intent is present.
- Track match quality per topic token:
  - `id`: exact `statistics_id`, `node_id`, or `table_id`.
  - `word`: exact normalized word in label/node/statistic.
  - `substring`: current fallback behavior for longer natural-language tokens.

Geo scoring:

- If `requestedGeoIds` is empty, no geo score is added; behavior is identical to topic-only ranking.
- If an entry supports one of the requested geos AND every topic token's match quality is `id` or `word`, add `GEO_MATCH_BOOST = 8` per matched requested geo (capped at the number of distinct requested geos to avoid double-counting when the same geo appears twice in the alias map).
- If an entry supports the requested geo but at least one topic token only matches as a substring, do not apply the boost. This prevents `atur` inside `naturalesa` from outranking a real unemployment table.
- If an entry does not support the requested geo, do not hard-filter it out. Keep it eligible so clients can see the actual available geos and recover cleanly when the requested geography does not exist for the best topic table.

Why `GEO_MATCH_BOOST = 8`: the bonus needs to (a) be smaller than B7 (+20, exact `statistics_id` direct hit) and B1 (+15, full phrase in label) so a strong topic match always beats a weak topic match with matching geo, (b) be larger than B4/B5 (+3/+2 adjacent-pair bonuses) so it can break ties between two same-statistic rows that differ only on geo coverage, and (c) be smaller than `PRIORITY_BOOST_FACTOR × 1 = 12` (the smallest canonical-priority differential) so geo-on-non-canonical never beats canonical-without-geo. +8 sits in this band. Round-1 verification is to print top-5 for `poblacio comarca`, `poblacio municipi`, `afiliacions comarca`, `atur comarca` against the real CA index post-refresh and eyeball before committing.

Comparator order:

```ts
score desc
-> requested geo match count desc        // tiebreak only; see note below
-> canonical statistic priority desc
-> same-stat open-ended series first
-> first topic token position in label asc
-> label.localeCompare
```

Note on the geo-match-count tiebreak: when the boost was applied, geo support is already in `score`, so this clause is redundant for boosted rows. It fires only when two rows tie on `score` AND the boost was gated off (substring-only topic match) — a narrow but real case where two `naturalesa`-style substring matches differ on geo coverage and we want determinism. Cheap to compute, no observable downside; keep it.

Acceptance examples:

- `poblacio comarca` returns PMH table(s) with `geo_candidates` containing `com`, and the first result can be passed to `idescat_list_table_geos`.
- `poblacio municipi` keeps PMH first and orders `mun` early in `geo_candidates`.
- `afiliacions comarca` returns AFI table(s) that support `com` above AFI tables that only support `cat`.
- `atur comarca` no longer returns an empty list. It should either return a strong `atur` table with `com` if IDESCAT exposes one, or return the strongest real `atur` table with its actual `geo_candidates` so the client can report the requested geography is unavailable.
- `atur comarca` must not promote unrelated tables whose only topic hit is a substring match inside `naturalesa`.

## MCP UX Updates

Update `src/mcp/tools/idescat.ts` only in human/model-facing copy:

- `idescat_search_tables`: mention that geography words such as `comarca`, `municipi`, and `provincia` are recognized, and returned `geo_candidates` should be confirmed with `idescat_list_table_geos`.
- `idescat_query_workflow`: add a short rule: when a query includes a geography, prefer search results whose `geo_candidates` include the requested `geo_id`; still call `idescat_list_table_geos` before metadata/data.
- Recovery text: if requested geography is absent from top results, try another result or explain the available geographies from `idescat_list_table_geos`; do not invent a `geo_id`.

README changes should be minimal: one sentence in the IDESCAT workflow section is enough.

## Implementation Outline

Order matters: index shape and parser come first so refresh + runtime can land together; geo-aware ranking follows; UX copy and canary close out.

1. **Extend the index entry shape** — `src/sources/idescat/search-index/types.ts`: add `geo_ids?: string[]` to `IdescatSearchIndexEntry`. No other source files require changes for this step (TypeScript will surface every read-site).
2. **Extract a shared geo-href parser** — pull the 4-segment href parsing out of `src/sources/idescat/catalog.ts:listIdescatTableGeos` into a small helper (e.g. `parseGeoIdsFromCollection(collection, parents)`) co-located in `catalog.ts` and re-exported. Refactor `listIdescatTableGeos` to use it. No behavior change.
3. **Update refresh script** — `scripts/refresh-idescat.ts`: after each table is discovered, fetch its geo collection (paced/retried via the existing fetcher), call the shared parser, sort the resulting IDs, attach as `geo_ids`. Cache by `${statistics_id}/${node_id}/${table_id}` across language passes.
4. **Add geo-query analyzer** — `src/sources/idescat/search-geography.ts` (new): exports `analyzeIdescatDiscoveryQuery(query)` returning `{ topicTokens, geoTokens, requestedGeoIds }`, `orderGeoCandidates(available, requested)`, `CANONICAL_GEO_ORDER`, and the alias map. Aliases are stored as already-`normalizeSearchTerm`'d strings to match haystack form. Multi-token aliases (`seccio censal`, `ambit territorial`) match before single-token aliases via greedy longest-prefix scan over the normalized token sequence.
5. **Wire ranking** — `src/sources/idescat/search.ts`: in `rankIdescatSearchResults`, call the analyzer once at the top; replace `tokens` with `topicTokens` for eligibility/per-token tier; track per-token match quality (`id|word|substring`); compute `geoMatchCount` and apply `GEO_MATCH_BOOST = 8` only when all topic tokens are `id|word`; populate `RankCandidate.geoMatchCount`; add the geo-match-count tiebreak between `score` and `priority` in the comparator. Output mapping uses `orderGeoCandidates` for `geo_candidates`. The tools-facing search-priority constants (`STOP_TOKENS`, `CANONICAL_STATISTIC_PRIORITY`, `PRIORITY_BOOST_FACTOR`) stay in `search-priority.ts`; add `GEO_MATCH_BOOST` next to them.
6. **Update MCP-facing copy** — `src/mcp/tools/idescat.ts`: extend `idescat_search_tables` description and `idescat_query_workflow` prompt as described under "MCP UX Updates". No schema changes (the existing `geo_candidates: z.array(z.string()).nullable()` already supports the populated case).
7. **Augment the live canary** — `scripts/idescat-live-canary.mjs`: keep the existing `poblacio sexe edat` + `cat` flow; add a second flow that runs `idescat_search_tables({ query: "poblacio comarca" })`, asserts the top result has `geo_candidates` containing `"com"`, then runs `list_table_geos → metadata → data` with `geo_id: "com"`. Either run them sequentially or refactor into a small test harness; the simpler change is sequential.
8. **Refresh the committed index** — run `npm run refresh:idescat` (or whatever the script is wired to in `package.json`) and commit the regenerated `src/sources/idescat/search-index/{ca,en,es}/*.ts` plus shard barrels. This is the largest diff in the slice.

## Critical Files

- Modify: `src/sources/idescat/search-index/types.ts` — add optional `geo_ids`.
- Modify: `src/sources/idescat/catalog.ts` — extract shared geo-href parser.
- Modify: `src/sources/idescat/search.ts` — replace tokens with topicTokens for eligibility, track match quality, apply geo boost, comparator update, `geo_candidates` mapping.
- Modify: `src/sources/idescat/search-priority.ts` — add `GEO_MATCH_BOOST = 8`.
- Add: `src/sources/idescat/search-geography.ts` — analyzer, alias map, ordering helpers, `CANONICAL_GEO_ORDER`.
- Modify: `scripts/refresh-idescat.ts` — geo-collection crawl pass, cross-language cache, sorted `geo_ids` on each entry.
- Modify (regenerate): `src/sources/idescat/search-index/{ca,en,es}/**` — committed refreshed index files.
- Modify: `src/mcp/tools/idescat.ts` — search-tool description, workflow prompt, recovery text.
- Modify: `tests/sources/idescat/search.test.ts` — synthetic fixture extension, geo discovery `it.each`, real-CA regression block, replace skipped `atur comarca` placeholder.
- Modify: `tests/scripts/refresh-idescat.test.ts` — already exists; add geo-collection mocks, sorted `geo_ids`, cross-language cache assertion.
- Modify: `tests/mcp/server.test.ts` — assert tool description and workflow prompt mention `geo_candidates` and `idescat_list_table_geos`; assert structured content includes `geo_candidates` as an array when hints are present.
- Modify: `scripts/idescat-live-canary.mjs` — add the `poblacio comarca` + `geo_id: "com"` flow alongside the existing case.
- Read-only references: `src/sources/idescat/search-index/types.ts`, the existing alias-style data file `src/sources/idescat/search-priority.ts`, `src/mcp/tools/idescat.ts:419` (the `geo_candidates` schema, unchanged).

## Tests

- `tests/scripts/refresh-idescat.test.ts` (extends existing file):
  - Mock table-geo collections and assert generated entries include alphabetically sorted `geo_ids`.
  - Assert the cross-language cache: a `ca + en + es` refresh with the same table tuple issues exactly one geo-collection fetch per unique tuple (count `fetchFn` invocations against the geo URL set).
- `tests/sources/idescat/search.test.ts`:
  - Unit-test `analyzeIdescatDiscoveryQuery`: alias normalization, multi-token-before-single-token (`seccio censal` → `[sec]` not `[sec, …]`), dedup on repeats, geo-only query returns no topic tokens.
  - `it.each` discovery cases (synthetic fixtures with explicit `geo_ids`):
    - `poblacio comarca` → top is PMH fixture with `geo_ids: ["cat","com","mun"]`; `geo_candidates[0] === "com"`.
    - `poblacio municipi` → PMH first, `geo_candidates[0] === "mun"`.
    - `afiliacions comarca` → AFI-with-`com` ranks above AFI-with-only-`cat`.
    - `atur comarca` → e03 fixture with `atur` as exact word in label ranks first; a synthetic `naturalesa` fixture with `com` does NOT geo-boost (substring-only topic match) and does not surface as top.
    - `comarca` alone → empty result list (geo-only query).
  - Replace the existing `it.skip("does not solve geo-style atur comarca queries", …)` placeholder with the assertion that `atur comarca` returns e03/`com`-supporting tables and `geo_candidates[0] === "com"`.
  - Real-CA-index regression block (hermetic, post-refresh):
    - `poblacio comarca` → top `statistics_id === "pmh"`, `geo_candidates` contains `"com"`.
    - `poblacio sexe edat` (no geo) → unchanged top result (PMH/8078); `geo_candidates` is non-null and non-empty.
    - `atur comarca` → top result's `geo_candidates` either contains `"com"` (if e03/afic comarca-level tables exist) or it doesn't (if IDESCAT only exposes `cat` for the canonical atur table). The assertion is on shape — `geo_candidates` is non-null — not on whether `com` is present.
- `tests/mcp/server.test.ts`:
  - Assert the `idescat_search_tables` description and `idescat_query_workflow` prompt mention `geo_candidates`, name `idescat_list_table_geos` as the confirmation step, and instruct against inventing a `geo_id`.
  - Assert a mocked search response with populated `geo_ids` returns `geo_candidates` as an array (not `null`) in the structured content.

## Verification

`npm run check` is the umbrella and runs everything in CI order. Listed individually so failures localize:

1. `npm run typecheck` — catches every read-site of `IdescatSearchIndexEntry` after the optional field is added; should be a no-op with `geo_ids?` since existing reads don't touch it.
2. `npm run lint` — Biome on the new analyzer module.
3. `npm test` — vitest covers the synthetic fixtures, geo analyzer, refresh-script geo crawl, MCP description/prompt assertions, and real-CA regression block.
4. `npm run smoke` — end-to-end through the MCP server; confirms no runtime regression on existing tools and that `geo_candidates` populates without throwing.
5. `npm run package:size` — gates the index growth from adding `geo_ids` per entry. Expected delta: ~3–5 KB per language file (≤ ~20 bytes per entry × ~30k entry-lines / shard, depending on average geo count). Hard fail if outside the existing budget.
6. `npm run check` — final umbrella before commit.
7. `npm run canary:idescat` — manual, live-upstream-dependent. Required when refreshing the committed index, and to validate the new `poblacio comarca` flow against real IDESCAT.

## Risks

- Refresh time increases because table geo collections must be crawled. The shared geo cache and existing pacing keep this bounded (see also the bounded estimate below).
- Index/package size increases. Expected growth is small because `geo_ids` are short arrays, but `npm run package:size` must remain the guardrail.
- Some user phrases are ambiguous: `municipi` can mean a geography cut or a table dimension such as municipality size. Prefer exact requested geos, but keep topic-first scoring so geography words do not erase topic relevance.
- Some desired topic/geography pairs may not exist in IDESCAT Tables v2. The product should make absence visible through `geo_candidates` and `list_table_geos`, not manufacture a table/geo pair.
- `GEO_MATCH_BOOST = 8` is calibrated by analytical bounds (between B4/B5 and B7/B1, smaller than the smallest `PRIORITY_BOOST_FACTOR × 1` differential), not by simulation. If a query class surfaces where +8 either over- or under-corrects, the constant lives next to `PRIORITY_BOOST_FACTOR` in `search-priority.ts` and is a one-line change with a follow-up regression test.
- Refresh time roughly doubles: every table needs an additional fetch for its geo collection. Bounded by the cross-language cache (one fetch per unique tuple, not per language) and the existing `DEFAULT_PACE_MS = 250` rate limit. Estimated added wall time: tens of minutes per full refresh on the current corpus; manual job, not CI-blocking.
