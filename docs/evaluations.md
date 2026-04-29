# MCP Evaluations

This repository has two kinds of quality checks:

- **Unit and contract tests**: deterministic Vitest coverage over local code, fixtures, validators, and request builders.
- **Live MCP evaluations**: protocol-level checks that start `node dist/index.js`, call the MCP server over stdio, and grade the resulting tools, prompts, and resources with binary expectations.

The live evals intentionally test the server the way an MCP client sees it. They do not import source modules directly, and they do not ask a model to judge correctness.

## Commands

```bash
npm run eval:replay:canary
npm run eval:replay:stress
npm run eval:canary
npm run eval:stress
```

All commands build first. Reports are written to `tmp/mcp-eval-<profile>-<timestamp>.json`.

Use an explicit report path when comparing runs:

```bash
node scripts/evaluate-mcp.mjs --profile=stress --report=tmp/mcp-eval-stress.json
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--profile=canary` | Fast live eval over MCP health and core Socrata, Open Data BCN, and IDESCAT flows. |
| `--profile=stress` | Full live eval over discovery, metadata, data, resources, caps, and error behavior. |
| `--mode=live` | Call the MCP server directly without reading or writing a cassette. |
| `--mode=record` | Call the MCP server directly and write a cassette after a green run. |
| `--mode=replay` | Run against a recorded cassette without starting the MCP server. |
| `--cassette=path` | Override the default cassette path. |
| `--quiet` | Print only failures and the final JSON summary. |
| `--fail-fast` | Stop at the first failed eval case. |

## Profiles

### Canary

The canary profile is the release-readiness smoke layer. It verifies:

- MCP server health through `ping`.
- Socrata catalog search, metadata, selected-field query, and upstream query error handling.
- Open Data BCN package search, resource recommendation, DataStore query, place resolution for landmarks, streets, neighborhoods, and districts, inactive-resource error recovery, and CSV preview.
- IDESCAT search, geos, metadata, bounded data, place guidance, multilingual search, and the long-filter GET regression.

### Stress

The stress profile is the adapter-health suite. It currently targets the same coverage shape as the manual stress run:

- `MCP: 1`
- `Socrata: 53`
- `Open Data BCN: 19`
- `IDESCAT: 71`
- `Total: 144`

It includes broad Socrata catalog searches, no-result searches, pagination, schema validation errors, dataset describes, SODA query shapes, upstream errors, prompt checks, resource reads, BCN resource recommendations, BCN place resolution across landmark, street, neighborhood, and district resources, BCN geospatial queries with DataStore SQL pushdown, area polygon filtering, and nearest group samples, IDESCAT table search, browse APIs, metadata, resource reads, long multi-value data filters, local validation caps, upstream `narrow_filters`, and low response-cap degradation behavior.

## Scoring

Every case is binary:

```json
{
  "id": "idescat.data.population_mun_long_filter_250",
  "passed": true,
  "score": 1,
  "reason": "250-municipality filter stays GET and selects exactly 250 cells"
}
```

Binary scoring is deliberate for this MCP because most desired behaviors are structural and deterministic:

- A tool should return `structuredContent.data`, or a structured tool error.
- An error should expose the expected `code`, `status`, or `source_error.rule`.
- A data call should preserve provenance and row caps.
- The IDESCAT long-filter regression should return `request_method: "GET"`, no request body params, and the exact selected cell count.

Each case also records sub-assertions for triage:

```json
{
  "name": "selected_cell_count",
  "passed": true,
  "expected": 250,
  "actual": 250
}
```

The top-level score remains binary, but failed sub-assertions show the exact contract that broke. The final report also records connector counts. A run fails if any case fails or if the profile no longer executes the expected number of cases.

## Record and Replay

Replay mode is the deterministic lane. It uses committed cassettes in `tests/fixtures/evals/`:

```bash
npm run eval:replay:canary
npm run eval:replay:stress
```

Record mode is the refresh lane. It calls live Socrata and IDESCAT services, then overwrites the profile cassette only after the full eval run passes:

```bash
npm run eval:record:canary
npm run eval:record:stress
```

Cassettes are captured at the MCP protocol boundary. They store the method (`callTool`, `getPrompt`, or `readResource`), scope (`default` or `low-cap`), stable params, and the resulting MCP response. The evaluator de-duplicates identical interactions inside a recording run, so repeated metadata calls share one cassette entry.

Use replay when you want to know whether local code still satisfies the known-good MCP contract. Use live or record mode when you want to know whether the current upstream services still satisfy that contract.

## Report Shape

Each report contains:

- `generated_at`, `completed_at`, and `duration_ms`.
- `profile`, package metadata, and the evaluated server command.
- `evaluation.mode` and `evaluation.cassette_path`, when applicable.
- `cases[]` with inputs, pass/fail score, sub-assertions, duration, status, and a compact result summary.
- `summary` with total score, per-connector counts, expected counts, and count mismatches.

The report is meant to be machine-readable for CI, release checklists, and trend dashboards.

## Evaluation Design

The suite uses deterministic validators instead of model graders. That is the gold standard for this MCP layer because the server is a typed adapter to public APIs, not an open-ended text generation task.

Good eval cases should:

- Exercise the public MCP surface: tools, prompts, and resources.
- Use stable public datasets or stable error expectations.
- Prefer exact structural assertions over fuzzy content assertions.
- Include negative cases for invalid input, upstream errors, byte caps, and row caps.
- Keep live upstream flakiness isolated to live/record evals instead of `npm run check`.

Open-ended model-in-the-loop evals can be added later on top of this harness, but they should answer a different question: whether an agent chooses the right MCP calls and interprets the results correctly.

## Environment

The evaluator starts the server with:

- `LOG_LEVEL=silent`
- `CATALUNYA_MCP_REQUEST_TIMEOUT_MS=60000`, unless already set
- `SOCRATA_APP_TOKEN`, when present in the parent environment

The stress profile also starts a second low-cap server with `CATALUNYA_MCP_RESPONSE_MAX_BYTES=65536` to validate truncation and degradation behavior.

## Maintenance

When adding a case:

1. Put it in the smallest useful profile.
2. Give it a stable `id` using `<connector>.<area>.<scenario>`.
3. Assert the behavior that matters to callers.
4. Update the expected connector counts.
5. Run `npm run eval:canary` or `npm run eval:stress`.

If a live upstream dataset changes, prefer updating the fixture-like expectation to another stable public dataset over weakening the assertion.
