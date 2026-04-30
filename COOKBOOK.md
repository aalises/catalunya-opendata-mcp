# Cookbook

Task-oriented examples for MCP clients using Catalunya Open Data MCP. These are intentionally small, bounded flows: discover the dataset/table, inspect metadata, then query with returned IDs.

## Socrata: Latest Housing Rows For Girona

User prompt:

> Show recent housing-start/completion rows for Girona.

Tool flow:

```json
{
  "tool": "socrata_search_datasets",
  "arguments": {
    "query": "habitatges iniciats acabats",
    "limit": 5
  }
}
```

Pick `source_id: "j8h8-vxug"`, then inspect valid field names:

```json
{
  "tool": "socrata_describe_dataset",
  "arguments": {
    "source_id": "j8h8-vxug"
  }
}
```

Query using `field_name` values, not display labels:

```json
{
  "tool": "socrata_query_dataset",
  "arguments": {
    "source_id": "j8h8-vxug",
    "select": "municipi, comarca_2023, any",
    "where": "municipi = 'Girona'",
    "order": "any desc",
    "limit": 10
  }
}
```

## Socrata: Aggregate Rows By Comarca

User prompt:

> Count housing records by comarca.

Tool flow:

```json
{
  "tool": "socrata_query_dataset",
  "arguments": {
    "source_id": "j8h8-vxug",
    "select": "comarca_2023, count(*) as total",
    "group": "comarca_2023",
    "order": "total desc",
    "limit": 20
  }
}
```

Use `socrata_describe_dataset` first if the client does not already have the dataset metadata attached.

## Socrata: Recover From A Bad Column

User prompt:

> Query the housing dataset for a field called municipality.

Recovery flow:

1. If `socrata_query_dataset` returns a Socrata `no-such-column` style error, do not guess a replacement.
2. Call `socrata_describe_dataset`.
3. Retry with the returned `columns[].field_name`, for example `municipi`.

```json
{
  "tool": "socrata_query_dataset",
  "arguments": {
    "source_id": "j8h8-vxug",
    "select": "municipi, comarca_2023, any",
    "limit": 10
  }
}
```

## IDESCAT: Population For Barcelones

User prompt:

> Get latest population for Barcelones.

Search with the named place included:

```json
{
  "tool": "idescat_search_tables",
  "arguments": {
    "query": "poblacio Barcelones",
    "lang": "ca",
    "limit": 5
  }
}
```

Common semantic phrasing works in the same search step: `taxa atur`, `paro comarca`, `renda per capita Maresme`, and `poblacio municipal` all stay within the standard `idescat_search_tables` workflow.

Choose a PMH result whose `geo_candidates` includes `com`, then confirm geographies:

```json
{
  "tool": "idescat_list_table_geos",
  "arguments": {
    "statistics_id": "pmh",
    "node_id": "1180",
    "table_id": "8078",
    "lang": "ca",
    "limit": 20
  }
}
```

Fetch metadata with the original place phrase:

```json
{
  "tool": "idescat_get_table_metadata",
  "arguments": {
    "statistics_id": "pmh",
    "node_id": "1180",
    "table_id": "8078",
    "geo_id": "com",
    "lang": "ca",
    "place_query": "Barcelones"
  }
}
```

Then use `filter_guidance.recommended_data_call` when present. For this table it should look like a bounded call with the matched comarca plus neutral totals:

```json
{
  "tool": "idescat_get_table_data",
  "arguments": {
    "statistics_id": "pmh",
    "node_id": "1180",
    "table_id": "8078",
    "geo_id": "com",
    "lang": "ca",
    "filters": {
      "COM": "13",
      "AGE": "TOTAL",
      "SEX": "TOTAL",
      "CONCEPT": "POP"
    },
    "last": 1,
    "limit": 20
  }
}
```

## IDESCAT: Renda For Maresme

User prompt:

> Show renda per capita data for Maresme.

Search:

```json
{
  "tool": "idescat_search_tables",
  "arguments": {
    "query": "renda per capita Maresme",
    "lang": "ca",
    "limit": 5
  }
}
```

Choose an RFDBC result whose `geo_candidates` includes `com`, then confirm `geo_id: "com"` with `idescat_list_table_geos`.

Metadata with place guidance:

```json
{
  "tool": "idescat_get_table_metadata",
  "arguments": {
    "statistics_id": "rfdbc",
    "node_id": "13302",
    "table_id": "21197",
    "geo_id": "com",
    "lang": "ca",
    "place_query": "Maresme"
  }
}
```

Use the recommended bounded data call:

```json
{
  "tool": "idescat_get_table_data",
  "arguments": {
    "statistics_id": "rfdbc",
    "node_id": "13302",
    "table_id": "21197",
    "geo_id": "com",
    "lang": "ca",
    "filters": {
      "COM": "21",
      "CONCEPT": "GROSS_INCOME",
      "MAIN_RESOURCES_USES_INCOME": "TOTAL"
    },
    "last": 1,
    "limit": 20
  }
}
```

If the user only wants the absolute value, add `INDICATOR: "VALUE_EK"` after confirming that category in metadata. The server does not choose it automatically because it is not a neutral default.

## Open Data BCN: Query Active City Equipment Data

User prompt:

> Show a small sample of Barcelona piezometers by district and neighborhood.

Search Open Data BCN packages:

```json
{
  "tool": "bcn_search_packages",
  "arguments": {
    "query": "piezometres equipaments",
    "limit": 5
  }
}
```

Pick package `e7a90d92-abf6-41d4-9310-da8b82b55b49`, then inspect its resource:

```json
{
  "tool": "bcn_get_resource_info",
  "arguments": {
    "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3"
  }
}
```

Because this resource is DataStore-active, query it with structured filters or selected fields:

```json
{
  "tool": "bcn_query_resource",
  "arguments": {
    "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3",
    "fields": ["_id", "Districte", "Barri"],
    "limit": 10
  }
}
```

Use field IDs from `bcn_get_resource_info.fields`. Do not pass raw SQL or URL fragments.

## Open Data BCN: Recommend A City Resource

User prompt:

> Which BCN dataset should I use for facilities in Gràcia?

Start with the deterministic recommender when the request is broad but common:

```json
{
  "tool": "bcn_recommend_resources",
  "arguments": {
    "query": "facilities in Gracia district",
    "task": "within",
    "place_kind": "district",
    "limit": 3
  }
}
```

Use the top recommendation's `resource_id`, `suggested_tool`, and `example_arguments` as a starting point, then call `bcn_get_resource_info` when you need exact fields. If the topic is not covered by the curated recommender, fall back to `bcn_search_packages`.

## Open Data BCN: Plan Or Execute A City Question

User prompt:

> What tree species are on Carrer Consell de Cent?

Use the planner when you want the server to assemble the workflow without running the final query:

```json
{
  "tool": "bcn_plan_query",
  "arguments": {
    "query": "tree species on Carrer Consell de Cent",
    "limit": 10
  }
}
```

For a one-call bounded result, use the executor:

```json
{
  "tool": "bcn_execute_city_query",
  "arguments": {
    "query": "facilities near Sagrada Família",
    "radius_m": 1500,
    "limit": 10
  }
}
```

For a caller-ready deterministic answer, use the answer composer:

```json
{
  "tool": "bcn_answer_city_query",
  "arguments": {
    "query": "tree species on Carrer Consell de Cent",
    "limit": 10
  }
}
```

The executor embeds the full plan and runs only when `status` is `ready`; otherwise it returns `execution_status: "blocked"`. `bcn_answer_city_query` uses that same executor, then adds `answer_text`, `answer_markdown`, `answer_type`, compact grouped/nearest-row summaries, warning `caveats`, informational `execution_notes`, selected resource metadata, citation guidance, and the raw `final_result`. Row summaries include `summary.rows[].source_row` so clients can render the concise label/fields view while preserving the exact row behind it. `place_kind: "point"` resolves only point-like BCN sources (`landmark` and `facility`), while street/area kinds pass through. Area candidates populate `within_place` from `selected_candidate.area_ref`.

Example answer-composer calls:

```json
{
  "tool": "bcn_answer_city_query",
  "arguments": {
    "query": "facilities near Sagrada Família",
    "radius_m": 1500,
    "limit": 5
  }
}
```

```json
{
  "tool": "bcn_answer_city_query",
  "arguments": {
    "query": "count facilities in Gràcia by neighborhood",
    "limit": 5
  }
}
```

## Open Data BCN: Preview Street Trees CSV

User prompt:

> Preview the Barcelona street trees CSV.

Search:

```json
{
  "tool": "bcn_search_packages",
  "arguments": {
    "query": "arbrat viari",
    "limit": 5
  }
}
```

Pick package `27b3f8a7-e536-4eea-b025-ce094817b2bd`, then inspect resource `23124fd5-521f-40f8-85b8-efb1e71c2ec8`. If `datastore_active` is false, use a bounded preview:

```json
{
  "tool": "bcn_preview_resource",
  "arguments": {
    "resource_id": "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
    "limit": 5
  }
}
```

Preview follows only allowlisted HTTPS Open Data BCN download URLs and returns sample rows, columns, parsing format, and truncation flags. Treat it as a sample, not a full export.

## Open Data BCN: Tree Species On A Street

User prompt:

> What tree species are on Carrer Consell de Cent?

Use the general geo helper against a coordinate-bearing resource. This is not hardcoded to trees: `contains` can target any street/name/address field, and `group_by` can count any returned field.

```json
{
  "tool": "bcn_query_resource_geo",
  "arguments": {
    "resource_id": "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
    "contains": {
      "adreca": "Carrer Consell de Cent"
    },
    "group_by": "cat_nom_catala",
    "fields": ["adreca", "cat_nom_catala"],
    "limit": 10
  }
}
```

Use `groups` for the species counts and `rows` as examples with `_geo.lat` / `_geo.lon`. For `near` queries, groups also include `min_distance_m` and `sample_nearest`. If `truncation_reason` is `scan_cap`, treat counts as partial and narrow the query or raise the local geo scan cap.

## Open Data BCN: Facilities Near A Place

User prompt:

> Show facilities near Sagrada Familia.

First resolve the place name with BCN-bounded source data:

```json
{
  "tool": "bcn_resolve_place",
  "arguments": {
    "query": "Sagrada Familia",
    "kinds": ["landmark"],
    "limit": 3
  }
}
```

Then pass the selected candidate's `lat` and `lon` into `near`:

```json
{
  "tool": "bcn_query_resource_geo",
  "arguments": {
    "resource_id": "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    "near": {
      "lat": 41.4036,
      "lon": 2.1744,
      "radius_m": 750
    },
    "fields": ["name", "addresses_road_name", "addresses_neighborhood_name"],
    "limit": 10
  }
}
```

Rows are sorted by `_geo.distance_m` for `near` queries. DataStore resources with `near` or `bbox` use generated CKAN SQL internally, so large active resources avoid upstream-order scan misses while keeping the public input structured. If coordinate inference reports multiple candidate field pairs, retry with explicit `lat_field` and `lon_field`; if `scan_cap` appears, treat the result as partial.

## Open Data BCN: Resolve Streets And Areas

Street and area prompts can start with the same source-bounded resolver:

```json
{
  "tool": "bcn_resolve_place",
  "arguments": {
    "query": "Plaça Catalunya",
    "kinds": ["street"],
    "limit": 3
  }
}
```

```json
{
  "tool": "bcn_resolve_place",
  "arguments": {
    "query": "Gracia",
    "kinds": ["district", "neighborhood"],
    "limit": 5
  }
}
```

Use the returned `source_dataset_name`, `matched_fields`, and `kind` to choose the right candidate. For street-wide analyses such as trees on a street, prefer `bcn_query_resource_geo.contains`; for nearby facilities, pass the resolved `lat` and `lon` into `near`. District and neighborhood candidates include `area_ref` when BCN exposes boundary geometry.

## Open Data BCN: Facilities In A District Or Neighborhood

User prompt:

> Count facilities in the Gràcia district by neighborhood.

Resolve the district first:

```json
{
  "tool": "bcn_resolve_place",
  "arguments": {
    "query": "Gracia",
    "kinds": ["district"],
    "limit": 1
  }
}
```

Then pass the candidate's `area_ref` into `within_place`:

```json
{
  "tool": "bcn_query_resource_geo",
  "arguments": {
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
}
```

The tool uses the area's bbox for upstream SQL pushdown and then verifies exact polygon containment locally. Use `groups` for the neighborhood counts and `rows` as examples.

## IDESCAT: Recover When Geography Is Unavailable

User prompt:

> Give me atur by comarca.

Flow:

1. Search with `idescat_search_tables` using the full phrase, for example `atur comarca`.
2. Prefer a result with `com` in `geo_candidates`, but do not invent one.
3. Always call `idescat_list_table_geos` for the selected table.
4. If the selected table does not expose `com`, explain the available geographies or try another strong search result.

This keeps recovery grounded in IDESCAT metadata instead of guessing a `geo_id`.

## Citations

For Socrata answers, cite from `socrata_describe_dataset` output or attach:

```text
socrata://datasets/j8h8-vxug/metadata
```

For IDESCAT answers, cite from `idescat_get_table_metadata` output or attach:

```text
idescat://tables/pmh/1180/8078/com/metadata
```

For Open Data BCN answers, cite from `bcn_get_package`, `bcn_get_resource_info`, or attach:

```text
bcn://packages/27b3f8a7-e536-4eea-b025-ce094817b2bd
bcn://resources/52696168-d8bc-4707-9a09-a21c6c2669f3/schema
```

Search and list tools are discovery steps. Use metadata outputs or metadata resources for final citations.
