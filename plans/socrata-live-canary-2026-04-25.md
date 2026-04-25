# Socrata Live Canary — 2026-04-25

## Summary

Ran a live MCP in-memory canary against Generalitat Socrata using the public tool surface:

1. `socrata_search_datasets`
2. `socrata_describe_dataset`
3. `socrata_query_dataset`
4. `socrata_query_dataset` with an intentionally invalid field to capture the real 400 recovery shape

Captured at `2026-04-25T15:51:42.474Z`.

## Success Path

Search query: `habitatge`

Selected dataset:

```json
{
  "title": "Habitatges iniciats i acabats. Sèrie històrica trimestral 2000 – actualitat",
  "source_id": "j8h8-vxug",
  "api_endpoint": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json"
}
```

Describe returned `26` columns. Query selected the first two simple `field_name` values:

```json
["codi_idescat", "codi_ine"]
```

Query result summary:

```json
{
  "is_error": false,
  "row_count": 3,
  "truncated": true,
  "request_url": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json?%24select=codi_idescat%2C+codi_ine&%24limit=4&%24offset=0",
  "logical_request_url": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json?%24select=codi_idescat%2C+codi_ine&%24limit=3&%24offset=0",
  "first_row": {
    "codi_idescat": "250479",
    "codi_ine": "25047"
  }
}
```

This confirms the sentinel behavior: actual `request_url` used `$limit=4`, while `logical_request_url` used the visible `$limit=3`.

## 400 Recovery Shape

Intentional invalid query:

```json
{
  "source_id": "j8h8-vxug",
  "where": "definitely_not_a_field = 'x'",
  "limit": 1
}
```

The MCP tool returned the expected structured error. The long SQL excerpt in `error.message` is abridged below, but the shape and key Socrata signals are real:

```json
{
  "data": null,
  "provenance": {
    "source": "socrata",
    "source_url": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json?%24where=definitely_not_a_field+%3D+%27x%27&%24limit=2&%24offset=0",
    "id": "analisi.transparenciacatalunya.cat:dataset_query",
    "last_updated": null,
    "license_or_terms": null,
    "language": "ca"
  },
  "error": {
    "source": "socrata",
    "code": "http_error",
    "message": "Socrata request failed with HTTP 400 Bad Request. Response body: {\"message\":\"Query coordinator error: query.soql.no-such-column; No such column: definitely_not_a_field; position: ... [abridged]\",\"errorCode\":\"query.soql.no-such-column\",\"data\":{\"column\":\"definitely_not_a_field\", ...}}",
    "retryable": false,
    "status": 400
  }
}
```

Use this shape for README or PR examples when explaining query self-correction.
