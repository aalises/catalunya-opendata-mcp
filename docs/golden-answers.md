# Golden Answer Examples

These examples show the answer shapes a client should expect from `bcn_answer_city_query`.
They are intentionally compact: render `answer_markdown` or `answer_text`, preserve
`final_result` for drill-down/debugging, surface `caveats` as user-visible warnings, and treat
`execution_notes` as operator/debug context.

Machine-readable contract:
[`docs/contracts/bcn-answer-city-query.schema.json`](./contracts/bcn-answer-city-query.schema.json).

The grouped, nearest, blocked, and empty examples mirror cases in the committed stress replay
cassette. The bbox fallback example mirrors the focused unit fixture for an area candidate that
has a bbox but no `area_ref`.

> **Note:** Examples below are abbreviated to the client-relevant fields. Every live response
> additionally includes `citation`, `plan`, and `execution_notes`; completed answers also include
> `final_result`. See the JSON Schema for the full required-field list. `final_tool` and
> `final_arguments` are conditional and only appear when a sub-tool was invoked.

## 1. Grouped Answer

User question:

```text
Which tree species are on Carrer Consell de Cent?
```

Tool call:

```json
{
  "name": "bcn_answer_city_query",
  "arguments": {
    "query": "tree species on Carrer Consell de Cent",
    "limit": 5
  }
}
```

Expected answer contract:

```json
{
  "execution_status": "completed",
  "answer_type": "grouped_counts",
  "answer_text": "For \"tree species on Carrer Consell de Cent\", top cat_nom_catala values are Lledoner (299), Plàtan (170), Estercúlia; firmiana (34), Arbre de l'amor; Arbre de Judas (29), Til·ler d'Armènia (13). Matched 586 rows.",
  "answer_markdown": "**tree species on Carrer Consell de Cent**\n\n| cat\\_nom\\_catala | Count |\n| --- | ---: |\n| Lledoner | 299 |\n| Plàtan | 170 |\n| Estercúlia; firmiana | 34 |\n| Arbre de l'amor; Arbre de Judas | 29 |\n| Til·ler d'Armènia | 13 |\n\n- Matched 586 rows\\.",
  "summary": {
    "type": "grouped_counts",
    "groups": [
      { "key": "Lledoner", "count": 299 },
      { "key": "Plàtan", "count": 170 },
      { "key": "Estercúlia; firmiana", "count": 34 }
    ]
  },
  "caveats": [
    "Place query was inferred deterministically from the question text.",
    "Final result was truncated because of scan_cap: scan reached the configured BCN geo row cap; narrow bbox, contains, or filters, or unset CATALUNYA_MCP_BCN_GEO_SCAN_MAX_ROWS for unlimited trusted local scans"
  ],
  "execution_notes": [
    "Not DataStore-active; geospatial queries use BCN-hosted CSV download scans.",
    "Final query used a BCN-hosted download scan; optional configured byte and row caps apply when set."
  ]
}
```

Client expectations:

- Render the grouped table from `answer_markdown` or `summary.groups`.
- Show the `scan_cap` caveat as a warning; the counts are useful but may be partial.
- Preserve `final_result` because it contains the raw rows, all groups, provenance, and scan
  metadata.

## 2. Nearest Answer With Map Points

User question:

```text
What facilities are near Sagrada Família?
```

Tool call:

```json
{
  "name": "bcn_answer_city_query",
  "arguments": {
    "query": "facilities near Sagrada Família",
    "radius_m": 1500,
    "limit": 5
  }
}
```

Expected answer contract:

```json
{
  "execution_status": "completed",
  "answer_type": "nearest_rows",
  "answer_text": "Closest results for \"facilities near Sagrada Família\" are Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte (0 m), Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte (0 m), Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte (0 m), Museu Temple Expiatori (292 m), Biblioteca (748 m). Matched 48 rows within 1500 m.",
  "summary": {
    "rows": [
      {
        "label": "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte",
        "distance_m": 0,
        "fields": {
          "name": "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte",
          "secondary_filters_name": "Sales d'estudi",
          "addresses_road_name": "Carrer de Provença",
          "addresses_neighborhood_name": "la Sagrada Família",
          "addresses_district_name": "Eixample"
        },
        "source_row": {
          "_geo": {
            "lat": 41.40541560676076,
            "lon": 2.1767746457391186,
            "distance_m": 0
          },
          "name": "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte"
        }
      }
    ],
    "map_points": [
      {
        "label": "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte",
        "lat": 41.40541560676076,
        "lon": 2.1767746457391186,
        "distance_m": 0,
        "source_row": {
          "_geo": {
            "lat": 41.40541560676076,
            "lon": 2.1767746457391186,
            "distance_m": 0
          },
          "name": "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte"
        }
      }
    ]
  },
  "caveats": [
    "Place query was inferred deterministically from the question text.",
    "Place resolution was truncated; additional BCN place candidates may exist.",
    "Final result was truncated because of row_cap: raise limit within maxResults or use offset to page through matched rows"
  ]
}
```

Client expectations:

- Render the nearest-row table from `answer_markdown` or `summary.rows`.
- Use `summary.map_points[]` directly for map pins.
- Use `summary.rows[].source_row` and `summary.map_points[].source_row` for detail panes without
  re-parsing `final_result`.
- Show `row_cap` as a warning and offer pagination or a higher bounded `limit` when appropriate.

## 3. Blocked Answer With Selection Options

User question:

```text
Show facilities in Les Corts.
```

Tool call:

```json
{
  "name": "bcn_answer_city_query",
  "arguments": {
    "query": "facilities in Les Corts",
    "limit": 5
  }
}
```

Expected answer contract:

```json
{
  "execution_status": "blocked",
  "answer_type": "blocked",
  "answer_text": "Cannot answer \"facilities in Les Corts\" deterministically yet: select one Barcelona place candidate from 3 candidates.",
  "answer_markdown": "**Cannot answer \"facilities in Les Corts\" deterministically yet: select one Barcelona place candidate from 3 candidates\\.**\n\n- Status: `needs_place_selection`\n- Place query: Les Corts\n- Place candidates: 3",
  "selection_options": {
    "selection_type": "place",
    "options": [
      {
        "id": "place:district:576bc645-9481-4bc4-b8bf-f5972c20df3f:4",
        "label": "Les Corts (district)",
        "kind": "district",
        "confidence": 1,
        "resume_arguments": {
          "query": "facilities in Les Corts",
          "task": "within",
          "place_query": "Les Corts",
          "place_kind": "district",
          "limit": 5
        }
      },
      {
        "id": "place:neighborhood:b21fa550-56ea-4f4c-9adc-b8009381896e:19",
        "label": "les Corts (neighborhood, Les Corts)",
        "kind": "neighborhood",
        "confidence": 1,
        "resume_arguments": {
          "query": "facilities in Les Corts",
          "task": "within",
          "place_query": "les Corts",
          "place_kind": "neighborhood",
          "limit": 5
        }
      }
    ]
  },
  "final_result": null
}
```

Client expectations:

- Do not fabricate a result table.
- Render a picker from `selection_options.options[]`.
- When a user picks an option, call `bcn_answer_city_query` again with that option's
  `resume_arguments`.
- Preserve option `provenance` when present; it includes the source resource, source URL, and
  `area_ref` for district/neighborhood choices.

## 4. Empty Result

User question:

```text
Show piezometers in a non-existent district.
```

Tool call:

```json
{
  "name": "bcn_answer_city_query",
  "arguments": {
    "query": "piezometers in a non-existent district",
    "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3",
    "task": "query",
    "filters": {
      "Districte": "NoSuchDistrict"
    },
    "fields": ["_id", "Districte", "Barri"],
    "limit": 5
  }
}
```

Expected answer contract:

```json
{
  "execution_status": "completed",
  "answer_type": "empty_result",
  "answer_text": "No rows matched \"piezometers in a non-existent district\" in the selected Open Data BCN resource.",
  "answer_markdown": "**No rows matched \"piezometers in a non\\-existent district\" in the selected Open Data BCN resource\\.**\n\n- Query: piezometers in a non\\-existent district",
  "summary": {
    "rows": []
  },
  "final_tool": "bcn_query_resource",
  "final_arguments": {
    "resource_id": "52696168-d8bc-4707-9a09-a21c6c2669f3",
    "fields": ["_id", "Districte", "Barri"],
    "filters": {
      "Districte": "NoSuchDistrict"
    },
    "limit": 5
  }
}
```

Client expectations:

- Render the empty state as a successful answer, not as an error.
- Preserve `final_result`; it proves the selected resource was queried and returned zero rows.
- Offer filter editing or broader search if the UI supports follow-up actions.

## 5. Bbox Fallback Caveat

User question:

```text
Show facilities in Gracia.
```

Tool call:

```json
{
  "name": "bcn_answer_city_query",
  "arguments": {
    "query": "facilities in Gracia",
    "place_kind": "district",
    "limit": 5
  }
}
```

Expected caveat contract when the selected area candidate lacks `area_ref` but has a bbox:

```json
{
  "execution_status": "completed",
  "answer_type": "empty_result",
  "caveats": [
    "Area candidate did not expose an area_ref; using its bbox as an approximate rectangular fallback.",
    "Area query used a bbox fallback, so results are based on a rectangular approximation."
  ],
  "final_arguments": {
    "bbox": {
      "min_lat": 41.39,
      "min_lon": 2.12,
      "max_lat": 41.43,
      "max_lon": 2.18
    }
  }
}
```

Client expectations:

- Treat this as a completed answer with warning caveats, not silent success.
- Display the bbox fallback caveat near the answer because the spatial filter is approximate.
- Prefer `within_place`/`area_ref` examples when available; bbox fallback is the degraded path.

## Cross-Cutting Client Rules

- `answer_markdown` is the display-ready default.
- `answer_text` is the compact fallback for clients without Markdown.
- `summary` is the compact UI model for tables, cards, maps, and empty states.
- `summary.rows[].source_row` and `summary.map_points[].source_row` are the drill-down payloads.
- `selection_options` means the answer is blocked and needs a user choice.
- `caveats` are user-facing warnings and should not be hidden in debug logs.
- `execution_notes` are operational context and can live in debug panels or traces.
- `final_result` is the raw lower-level tool result; preserve it even when rendering from
  `summary`.
