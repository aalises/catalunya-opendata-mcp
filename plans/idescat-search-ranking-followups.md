# IDESCAT Search Ranking Follow-Ups

## Next Backlog Item: English Substring Leakage

The targeted semantic alias slice improves high-value phrases such as `taxa atur`, `paro`, `renda per capita`, and `family income`, but it deliberately does not change the broader substring-matching policy.

Known issue:

- `population by age` against the English IDESCAT index is still tracked as an acknowledged limitation in `tests/sources/idescat/search.test.ts`.
- The problem is substring leakage from permissive fallback matching, not missing aliases.
- Treat this as a separate ranking-quality pass so fixes can be measured against existing exact-word, direct-ID, geography, and canonical-statistic priority behavior.

Suggested shape:

- Keep exact ID and exact word matches as the strongest eligibility signals.
- Make substring fallback more selective for English common words and short stems.
- Preserve current false-positive guards such as mixed IDs (`pmh atur`) and substring-only geo boost gating.
- Move the skipped `population by age` regression into the active suite only when the ranking change is implemented.
