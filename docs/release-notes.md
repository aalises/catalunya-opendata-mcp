# Release Notes

## 0.1.4 - 2026-04-30

### BCN City Questions

Open Data BCN now has a city-question layer on top of the lower-level CKAN/DataStore tools:

- `bcn_plan_query` turns common natural city questions into an inspectable, deterministic workflow with selected resource metadata, optional place resolution, final tool arguments, and citation guidance.
- `bcn_execute_city_query` runs the same plan end-to-end when it is safe and bounded, and blocks instead of guessing when a resource or place choice is ambiguous.
- `bcn_answer_city_query` composes caller-ready `answer_text` and `answer_markdown`, compact summaries, `selection_options` for blocked flows, `summary.rows[].source_row`, map-ready `summary.map_points[]`, citation guidance, caveats, execution notes, selected resource metadata, and the raw `final_result`.
- The BCN workflow now supports street/species grouping, named-place `near` queries, district/neighborhood `within_place` area queries, bbox fallback caveats when an area boundary lacks `area_ref`, source-bounded place resolution, and curated resource recommendations.
- Ambiguous resource and place matches now block with stable selection options instead of picking silently.

### Production Readiness

- `npm run release:check` runs the local gate plus the committed stress replay.
- The client-facing `bcn_answer_city_query` contract is now published as a JSON Schema and backed by contract tests over grouped answers, nearest/map answers, blocked selection flows, empty results, and bbox fallback caveats.
- Golden answer examples document the expected renderable answer shapes for client implementers.
- GitHub Actions runs `npm run check` and `npm run eval:replay:stress -- --quiet` on pull requests and `main`, and can be started manually.
- Package dry-run guidance now verifies the packed file list, package-size budgets, and executable `dist/index.js`.
- Latest local release gate on 2026-04-30 passed typecheck, Biome lint, 328 tests, smoke output, package-size budgets, and the full stress replay: 152/152 cases across MCP, Socrata, Open Data BCN, and IDESCAT.
- Latest live release evidence on 2026-04-30 passed all three canaries plus the full live stress suite: 152/152 cases, including 27 Open Data BCN cases.

The city-question tools remain deterministic: no external geocoding, no raw SQL exposed to callers, and no model-based parsing inside the server.

### Migration Notes

Existing low-level tools remain compatible. Clients that already call `bcn_query_resource`, `bcn_query_resource_geo`, or `bcn_resolve_place` can keep doing so. New clients should prefer:

- `bcn_plan_query` when they need to inspect or present the intended workflow before running it.
- `bcn_execute_city_query` when they need the bounded raw result.
- `bcn_answer_city_query` when they need a display-ready answer plus the raw `final_result`.

Treat `caveats` as warning-level user-facing information. Treat `execution_notes` as operational context for developers or advanced clients.
