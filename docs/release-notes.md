# Release Notes

## 0.1.4 - 2026-04-30

### BCN City Questions

Open Data BCN now has a city-question layer on top of the lower-level CKAN/DataStore tools:

- `bcn_plan_query` turns common natural city questions into an inspectable, deterministic workflow with selected resource metadata, optional place resolution, final tool arguments, and citation guidance.
- `bcn_execute_city_query` runs the same plan end-to-end when it is safe and bounded, and blocks instead of guessing when a resource or place choice is ambiguous.
- The BCN workflow now supports street/species grouping, named-place `near` queries, district/neighborhood `within_place` area queries, source-bounded place resolution, and curated resource recommendations.
- Fresh live canary and stress cassettes were recorded after the planner hardening pass. The stress profile now covers 149 MCP cases, including 24 Open Data BCN cases.

The city-question tools remain deterministic: no external geocoding, no raw SQL exposed to callers, and no model-based parsing inside the server.
