# Operational Runbook

This runbook covers release-time and incident-time decisions for the Catalunya Open Data MCP adapters.

## Upstream Availability

When Socrata, IDESCAT, or Open Data BCN is unavailable:

1. Re-run the failing command once to rule out a transient network failure.
2. Check whether deterministic local gates still pass:

```bash
npm run doctor -- --skip-upstream
npm run check
npm run eval:replay:stress -- --quiet
```

3. Run the full diagnostic command when you need current upstream reachability too:

```bash
npm run doctor
```

4. If replay passes and only live commands fail, treat the release as blocked on upstream evidence, not as a local regression.
5. Inspect the structured error:
   - `network_error`, `timeout`, retryable `http_error`: retry later or lower concurrency.
   - non-retryable `http_error`: verify IDs, fields, filters, or upstream API shape.
   - `invalid_response`: upstream shape drift or unexpected content; add a focused fixture/test before changing adapter behavior.
6. Do not refresh cassettes from a failing live run.

## Cassettes

Use replay mode for local and CI release gates:

```bash
npm run eval:replay:stress -- --quiet
```

Use record mode only after a live run is green and the observed upstream changes are expected:

```bash
npm run eval:record:stress -- --quiet
```

Before committing a cassette refresh:

- Confirm the connector counts are unchanged unless the eval suite intentionally changed.
- Review the diff for accidental credentials, volatile timestamps used as assertions, or unrelated upstream churn.
- Summarize why the refresh is acceptable in the commit message or release note.

## Caveats and Truncation

Treat `caveats` as user-facing warnings. They should be visible in client answers and logs because the answer may be partial or approximate.

Common caveats:

- `bbox` fallback: area results used a rectangular approximation because a district/neighborhood boundary did not expose `area_ref`.
- `row_cap`: more rows are available; increase `limit` within `CATALUNYA_MCP_MAX_RESULTS` or page with `offset`.
- `byte_cap`: narrow filters, reduce selected fields, or lower `limit`.
- `scan_cap`: narrow `bbox`, `contains`, or filters, or unset `CATALUNYA_MCP_BCN_GEO_SCAN_MAX_ROWS` for unlimited trusted local scans.

Treat `execution_notes` as operational context. They explain how a result was produced, such as CKAN SQL pushdown or BCN-hosted download scans.

## Release Owner Checklist

For routine changes:

```bash
npm run check
```

For release readiness:

```bash
npm run release:verify
npm pack --dry-run
test -x dist/index.js
```

For adapter changes or releases that need fresh upstream evidence:

```bash
npm run canary:live
npm run eval:stress -- --quiet
```

For package installation confidence, follow `docs/install-smoke.md`.

Before publishing or tagging:

- Confirm GitHub Actions is green on the commit being released.
- Confirm package size budgets pass.
- Confirm release notes include notable API shape changes, caveats, eval counts, and migration guidance.
- Confirm no live evidence requires cassette refresh.

When you want remote evidence without running live checks locally, start the **Live Canary** GitHub Actions workflow manually. Use the `canary` profile for a fast current-upstream check and the `stress` profile before accepting broad upstream drift.
