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

> Show renda data for Maresme.

Search:

```json
{
  "tool": "idescat_search_tables",
  "arguments": {
    "query": "renda Maresme",
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

Search and list tools are discovery steps. Use metadata outputs or metadata resources for final citations.
