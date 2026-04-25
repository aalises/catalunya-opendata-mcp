# Socrata Metadata Resource Live Canary — 2026-04-25

## Summary

Ran a live MCP in-memory canary against Generalitat Socrata using the new resource
surface:

1. `client.listResourceTemplates()`
2. `client.readResource({ uri: "socrata://datasets/j8h8-vxug/metadata" })`

Captured at `2026-04-25T16:08:07.000Z`.

## Resource Template

The resource template was listed by MCP:

```json
{
  "name": "socrata_dataset_metadata",
  "uriTemplate": "socrata://datasets/{source_id}/metadata",
  "mimeType": "application/json"
}
```

## Resource Read

Read URI:

```text
socrata://datasets/j8h8-vxug/metadata
```

Resource content summary:

```json
{
  "uri": "socrata://datasets/j8h8-vxug/metadata",
  "mimeType": "application/json",
  "body_bytes": 6374
}
```

The returned JSON is the dataset metadata artifact itself, not a tool envelope:

```json
{
  "has_tool_envelope": false,
  "source_id": "j8h8-vxug",
  "title": "Habitatges iniciats i acabats. Sèrie històrica trimestral 2000 – actualitat",
  "source_domain": "analisi.transparenciacatalunya.cat",
  "web_url": "https://analisi.transparenciacatalunya.cat/d/j8h8-vxug",
  "api_endpoint": "https://analisi.transparenciacatalunya.cat/resource/j8h8-vxug.json",
  "attribution": "Departament de Territori, Habitatge i Transició Ecològica",
  "attribution_link": "https://administraciodigital.gencat.cat/ca/dades/dades-obertes/informacio-practica/llicencies/",
  "license_or_terms": "See Terms of Use",
  "rows_updated_at": "2025-11-10T09:43:54.000Z",
  "view_last_modified": "2025-11-10T09:43:45.000Z",
  "column_count": 26
}
```

First five queryable columns:

```json
[
  {
    "display_name": "Codi IDESCAT",
    "field_name": "codi_idescat",
    "datatype": "text"
  },
  {
    "display_name": "Codi INE",
    "field_name": "codi_ine",
    "datatype": "text"
  },
  {
    "display_name": "Municipi",
    "field_name": "municipi",
    "datatype": "text"
  },
  {
    "display_name": "Codi Comarca 2015",
    "field_name": "codi_comarca_2015",
    "datatype": "text"
  },
  {
    "display_name": "Comarca 2015",
    "field_name": "comarca_2015",
    "datatype": "text"
  }
]
```

Dataset-level provenance:

```json
{
  "source": "socrata",
  "source_url": "https://analisi.transparenciacatalunya.cat/d/j8h8-vxug",
  "id": "j8h8-vxug",
  "last_updated": "2025-11-10T09:43:54.000Z",
  "license_or_terms": "See Terms of Use",
  "language": "ca"
}
```

This confirms the metadata resource is attachable JSON context for the same
dataset previously used in the query canary.
