# Plan: Improve `idescat_search_tables` ranking (phrase + canonical-statistic priority)

## Context

The recent IDESCAT polish work shipped a full crawled index (`scripts/refresh-idescat.ts` → sharded `src/sources/idescat/search-index/{ca,en,es}/*.ts`, 30+ statistics shards). With the full corpus, broad queries like `poblacio edat` now surface valid-but-non-canonical tables (COVID experimental tables, EUT, projections, estimations, census) above PMH (Padró municipal d'habitants), the canonical population register.

Root cause is in `rankIdescatSearchResults` (`src/sources/idescat/search.ts:100-141`):

- AND-gate haystack at `search.ts:112-114` includes only `label + ancestor_labels.statistic + ancestor_labels.node` (NOT `statistics_id`, `table_id`, or `node_id`).
- Per-token tier: +5 in `label`, +3 in `ancestor_labels.node`, +1 only in `ancestor_labels.statistic`.
- Many entries (PMH, EP, projections, COVID, EUT, CENSPH) all coincidentally have both `poblacio` and `edat` in their label. Tied scores fall back to alphabetical `localeCompare`, which pulls non-canonical labels ahead of `Població…`.
- `normalizeSearchTerm` (`search.ts:143-150`) only strips diacritics and collapses whitespace — it preserves apostrophes (`d'habitants`), hyphens (`covid-19`), en dashes (`2000–2013`), middle dots, slashes, commas.
- There is no signal distinguishing PMH from `proj`, `projl`, `ep`, `censph`, `eut`, or `covid`. Rank-only fixes cannot solve canonicality without an explicit signal.
- Phrase signals are insufficient on their own: for `poblacio sexe edat`, EP labels compact to the exact phrase `poblacio sexe edat` while PMH labels do not (PMH inserts `a 1 de gener` between), so EP earns a strong phrase bonus that priority-as-tiebreak alone cannot overturn. Priority must contribute to the score directly.

This is a valid next feature: the prior batch finished a polish plan but didn't touch ranking, and the regression is observable on real, discovery-style queries. Fix is internal scoring + a stronger normalizer + a small curated canonical-statistics priority map; the MCP tool name and output schema are unchanged. Numeric `score` values WILL shift (they are relative debug output, not a stable contract).

Intended outcome: queries like `poblacio edat`, `poblacio sexe edat`, `padro habitants`, `pmh`, `pmh 8078`, `ep`, `covid 19`, `sexe edat`, `atur ocupacio` return the canonical statistic at the top, validated by deterministic unit tests on synthetic fixtures AND a hermetic offline test that imports the committed CA + EN indices.

## Scope

Three files in source, one in tests:

- `src/sources/idescat/search.ts` — extend `normalizeSearchTerm` punctuation handling, add `buildPhraseHaystack`/`stripStop`, keep the substring AND-gate haystack text-only, add exact field-aware id matching, extend `rankIdescatSearchResults` scoring (canonicality bonus + open-series tiebreak), and change identifier eligibility to AND-with-text without a length gate.
- `src/sources/idescat/search-priority.ts` — new file, exports `STOP_TOKENS`, `CANONICAL_STATISTIC_PRIORITY`, and `PRIORITY_BOOST_FACTOR`.
- `tests/sources/idescat/search.test.ts` — extend synthetic fixtures (2 → 10 entries, adding `pmh-second`/`phre`/`proj`/`projl`/`ep`/`covid`/`eut`/`e03`), add a discovery `it.each`, add a hermetic real-index regression block importing `src/sources/idescat/search-index/{ca,en}.js`, add negative tests for id eligibility, add at least one `table_id`-level assertion.

Out of scope: index data regeneration, refresh crawler, MCP wiring/schemas, geo resolution (`atur comarca`-style geo queries), partial-token fuzzy fallback, stemming/singular-plural normalization (so `taxa atur` is NOT a goal — see Risks), and full word-boundary matching for long natural-language tokens (substring matching is preserved for tokens ≥3 chars).

## Normalizer change (`normalizeSearchTerm`)

Replace punctuation with spaces using the Unicode property class:

```ts
return value
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLowerCase()
  .replace(/\p{P}/gu, " ")     // NEW: any Unicode punctuation → space
  .replace(/\s+/gu, " ")
  .trim();
```

Effects:

- `Padró d'habitants` → `padro d habitants`
- `covid-19` → `covid 19`
- `Població a 1 de gener (2000–2013)` → `poblacio a 1 de gener 2000 2013`
- `S2/1986–S2/2011` → `s2 1986 s2 2011`
- `sexe, edat` → `sexe edat`
- `col·lectiu` → `col lectiu` (middle dot becomes space)

Existing test `normalizes accents and requires all query tokens` (`tests/sources/idescat/search.test.ts:52`) is unaffected (input `" Població   COMARCÀ "` has no punctuation).

## Phrase haystack and stop-stripped query (symmetric)

In `src/sources/idescat/search-priority.ts`:

```ts
export const STOP_TOKENS: ReadonlySet<string> = new Set([
  // CA
  "i","o","a","al","als","el","la","els","les","de","d","del","dels",
  "en","un","una","per","que","amb","sobre",
  // ES
  "y","u","los","las","por","con",
  // EN
  "the","of","in","and","or","to","for","an","by","with",
]);
```

Open-ended series detection is private to `search.ts` and must run against the original raw label, before punctuation normalization, so the dash that distinguishes open from closed ranges is still available:

```ts
// In search.ts, alongside normalizeSearchTerm, add:
const OPEN_SERIES_LABEL_REGEX = /\(\d{4}\s*[–\-]\s*\)/u;  // matches "(2014–)" or "(2014-)"
function isOpenEndedSeries(rawLabel: string): boolean {
  return OPEN_SERIES_LABEL_REGEX.test(rawLabel);
}
```

`isOpenEndedSeries` runs against the RAW label (pre-normalization) to preserve the dash that distinguishes open from closed ranges. Open-ended series is a useful signal for within-statistic table preference (see B10 below).

In `src/sources/idescat/search.ts`:

```ts
function stripStop(tokens: readonly string[]): string[] {
  return tokens.filter((t) => t.length > 0 && !STOP_TOKENS.has(t));
}

function buildPhraseHaystack(text: string): string {
  return stripStop(normalizeSearchTerm(text).split(" ")).join(" ");
}
```

Phrase formation (symmetric):

```ts
const tokens = normalizeSearchTerm(query).split(" ").filter(Boolean);   // for AND-gate / per-token tier
const phraseTokens = stripStop(tokens);                                 // for B1/B2/B4/B5
const phrase = phraseTokens.join(" ");
```

So `sexe i edat` has `tokens = ["sexe","i","edat"]` (used for AND-gate) and `phraseTokens = ["sexe","edat"]` → `phrase = "sexe edat"`. Phrase haystack of label `Per sexe i edat` is also `sexe edat` → B1/B4 fire.

Phrase bonuses gated on `phraseTokens.length >= 2`. If a user types only stop words, phrase bonuses are skipped silently.

## Eligibility (AND-with-text, field-aware id matching)

The substring haystack stays text-only — `label + ancestor_labels.statistic + ancestor_labels.node` — so id fields no longer leak via numeric substrings. Id matching is field-aware and exact:

```ts
const normHaystack = normalizeSearchTerm([
  entry.label,
  entry.ancestor_labels.statistic,
  entry.ancestor_labels.node,
].join(" "));
const haystackTokens = normHaystack.split(" ");

function tokenSatisfied(token: string, entry: IdescatSearchIndexEntry): boolean {
  // Field-aware exact-id matching
  if (token === entry.statistics_id.toLowerCase()) return true;
  if (token === entry.table_id) return true;
  if (token === entry.node_id) return true;
  // Short tokens (1–2 chars): word-boundary against haystack to avoid substring leakage
  if (token.length <= 2) return haystackTokens.includes(token);
  // Long tokens (≥3 chars): substring (existing behavior)
  return normHaystack.includes(token);
}
```

A row is eligible iff every query token is `tokenSatisfied` for that entry.

Why this shape:

- **`pmh` / `ep` / `ee` (2–3 char ids)** all satisfy via field-aware `statistics_id` match. No length gate; no substring leakage from `dependents` / `comestibles`.
- **`8078`, `15252`, etc. (table or node ids)** satisfy via exact `table_id` / `node_id` match. They are length-4+ but they were also leaking via substring on `node_id: "18078"`. Removing id fields from the substring haystack eliminates the false positive.
- **Long natural-language tokens** like `atur`, `padro`, `poblacio` keep substring behavior so partial matches (`atura` vs `atur`) still work as today.
- **Short non-id tokens** like a stray `ep` typed inside a longer query still match a label only if present as a whole word — preserves intent.

Per-token tier scoring still sees the substring haystack only. When eligibility is satisfied via exact-id match (token not present in label/node/statistic), that token contributes +5 base credit (treated as label-tier hit) so direct id queries score consistently with B7.

Negative behavior preserved: `pmh atur` ineligible (PMH has no `atur` token; other rows have no `pmh` id). `covid atur` ineligible. **Empty results.**

## Scoring change

Keep the existing per-token text tier (label=5, node=3, statistic=1). If a token is satisfied only by exact id-field matching, give it +5 base credit, treating direct id hits as label-strength matches. Add bonuses below, all stacking additively.

| ID  | Bonus                       | Condition                                                                                          | Weight        |
|-----|-----------------------------|----------------------------------------------------------------------------------------------------|---------------|
| B1  | Phrase-in-label             | `phraseTokens.length ≥ 2` AND `phraseLabel` contains `phrase`                                      | +15           |
| B2  | Phrase-in-node              | `phraseTokens.length ≥ 2` AND `phraseNode` contains `phrase`                                       | +8            |
| B4  | Adjacent-pair in label      | For each `i` in `0..phraseTokens.length-2`: pair substring of `phraseLabel`                        | +3 per pair   |
| B5  | Adjacent-pair in node       | Same against `phraseNode`                                                                          | +2 per pair   |
| B6  | Title coverage              | `T ≥ 2` AND every (full, not stripped) query token appears in normalized `label`                   | +4            |
| B7  | Statistics-id direct match  | Any token of length `≥ 3` equals `entry.statistics_id.toLowerCase()` exactly                       | +20           |
| B8  | Statistic coverage          | `T ≥ 2` AND every (full, not stripped) query token appears in normalized `ancestor_labels.statistic` | +6           |
| B9  | Canonical-statistic boost   | Always: `score += CANONICAL_STATISTIC_PRIORITY.get(entry.statistics_id) ?? 0` × `BOOST_FACTOR`     | priority × 12 |
| B10 | Open-ended series           | `isOpenEndedSeries(entry.label)` — used as a tiebreak ONLY among entries sharing the same `statistics_id`; not added to score | tiebreak only |

B9 is the structural change in v4: canonical-statistic priority is added to the SCORE (not just used as a tiebreaker). With `BOOST_FACTOR = 12`, priority 5 (PMH) contributes +60, priority 2 (EP/CENSPH/PHRE) contributes +24, priority 1 (proj/projl/projm) contributes +12, others contribute 0. The 36-point gap between PMH and a priority-2 competitor must dominate the typical 28-point phrase/adjacency stack a non-canonical row can earn from 3-token queries (B1+B2+B4+B5 = 15+8+6+4 ≈ 33 max for a 3-token query where all bonuses fire). A round-4 simulation of the v4 plan with `BOOST_FACTOR=8` showed PMH losing to CENSPH for `poblacio sexe edat` by 4 points; raising the factor to 12 closes the gap by 20 points, putting PMH safely ahead.

Two notes on B9:

- **Why a multiplier and not a flat bump:** higher-priority tiers (canonical population register) need a larger boost than mid-tier (employment) to dominate phrase advantages. A linear `priority × 12` keeps the relative gap meaningful. Tunable via `BOOST_FACTOR` constant if a future query class surfaces a need.
- **Why not gate B9 on score > 0:** every eligible row already has a positive base score (≥ 1 per matched token), so gating is unnecessary.

B7 KEEPS the length-≥3 gate. Reason: B7 is a strong +20 bonus on top of base+priority. For 2-character ids (`ep`, `ee`), B7 is skipped; the row still earns base credit + B9 priority + (length-≤2 word-boundary eligibility), which is enough to dominate non-canonical results without the full +20.

B10 is now a TIEBREAK, not a score bonus. The previous draft treated it as a flat +2 added to the score, which gave CENSPH a +2 cross-statistic bonus and made the `poblacio sexe edat` gap worse. The fix: B10 fires only when the comparator is comparing two entries with the same `statistics_id`. Example: PMH `1063` (`2000–2013`, closed) vs PMH `8078` (`2014–`, open) — same stat, B10 puts open-ended first. PMH vs CENSPH — different stat, B10 doesn't fire.

### Tiebreak chain (final)

Sort by:

```
score desc                                    // B9 already factored into score
→ canonicalStatisticPriority desc             // explicit secondary, mostly redundant with B9
→ (when same statistics_id) openSeries first  // B10 within-stat ordering
→ first-query-token-position-in-label asc
→ label.localeCompare
```

```ts
.sort((l, r) => {
  if (r.score !== l.score) return r.score - l.score;
  if (r.priority !== l.priority) return r.priority - l.priority;
  if (l.entry.statistics_id === r.entry.statistics_id && l.openSeries !== r.openSeries) {
    return l.openSeries ? -1 : 1;             // open before closed within same stat
  }
  if (l.firstPos !== r.firstPos) return l.firstPos - r.firstPos;
  return l.entry.label.localeCompare(r.entry.label);
});
```

```ts
const lbl = normalizeSearchTerm(entry.label);
const firstPos = (() => {
  if (tokens.length === 0) return Number.POSITIVE_INFINITY;
  const p = lbl.indexOf(tokens[0]);
  return p === -1 ? Number.POSITIVE_INFINITY : p;
})();
const priority = CANONICAL_STATISTIC_PRIORITY.get(entry.statistics_id) ?? 0;
```

### Curated priority list

```ts
// search-priority.ts
export const CANONICAL_STATISTIC_PRIORITY: ReadonlyMap<string, number> = new Map([
  ["pmh",   5],   // Padró municipal d'habitants — population register
  ["e03",   4],   // Mercat de treball — taxes d'activitat, ocupació, atur
  ["rfdbc", 4],   // Renda familiar disponible bruta
  ["ee",    3],   // Empreses i establiments
  ["afic",  3],   // Comptes de cotització SS
  ["phre",  2],   // Padró d'habitants residents a l'estranger
  ["ep",    2],   // Estimacions de població
  ["censph",2],   // Cens de població i habitatges
  ["proj",  1],   // Projeccions de població
  ["projl", 1],   // Projeccions de llars
  ["projm", 1],   // Projeccions municipals de població
]);
export const PRIORITY_BOOST_FACTOR = 12;
```

Documented as opinionated and tunable. Ids not in the map default to 0 (no boost).

### Worked examples (real CA index, illustrative — exact totals depend on B2/B5 stacking)

- `poblacio edat`: PMH base 10 + B6 +4 + B9 (+60) ≈ 74. proj/projl base 10 + B6 +4 + B9 (+12) ≈ 26. covid/eut/censph base 10 + B6 +4 + B9 (+0 to +24) ≈ 14–38. **PMH first by ~36 points.**
- `poblacio sexe edat` (3 tokens): CENSPH `Població. Per sexe i edat (2011–)` and EP `Població. Per sexe i edat (S1/2012–S1/2025)` both compact to phrase `poblacio sexe edat` → base 15 + B1 15 + B2 8 + B4 6 + B5 4 + B6 4 + B9 +24 ≈ 76. PMH `Població a 1 de gener. Per sexe i edat (2014–)` cannot earn B1/B2 (phrase not contiguous because `a 1 de gener` interrupts) → base 15 + B4 3 + B5 2 + B6 4 + B9 +60 ≈ 84. **PMH first by ~8 points.** This is the case `BOOST_FACTOR=12` is calibrated to win.
- `padro habitants`: PMH base 2 (both tokens only in stat) + B8 +6 + B9 +60 = 68. PHRE base 2 + B8 +6 + B9 +24 = 32. **PMH first.**
- `pmh`: PMH eligible via field-aware id match; base +5 (label-tier credit for id-satisfied token) + B7 +20 + B9 +60 = 85. Non-PMH ineligible. **Only PMH.**
- `pmh 8078`: PMH/8078 eligible (token `pmh` via `statistics_id`, token `8078` via `table_id`); base 5+5 + B7 +20 + B9 +60 = 90. Other PMH rows fail (token `8078` does not match their `table_id`). Other statistics fail (no matching `statistics_id`). **Exactly PMH/8078.**
- `pmh atur`: PMH ineligible (token `atur` has no match — not in any PMH text and not equal to a PMH id field). Other rows ineligible. **Empty.**
- `ep`: EP eligible via field-aware id match; base +5 + B9 +24 = 29 (no B7 due to length=2). CEPH ineligible because `ep` is length ≤2 and not a whole word in CEPH's normalized haystack tokens (`dependents` is one token, not two). **Only EP rows.**
- `8078` (bare numeric, length 4): only PMH/8078 has `table_id === "8078"`. CEPH/18078/21595 has `node_id: "18078"` but `node_id !== "8078"` exactly, and `8078` is not a substring of any CEPH label/stat/node text. **Exactly PMH/8078.** (This was a v4 false-positive case; v5 fixes it by removing id fields from the substring haystack and matching them as exact tokens instead.)
- `sexe edat`: PMH base 10 + B1 +15 + B2 +8 + B4 +3 + B5 +2 + B6 +4 + B9 +60 ≈ 102. EP base 10 + B1 +15 + B2 +8 + B4 +3 + B5 +2 + B6 +4 + B9 +24 ≈ 66. **PMH first.** Within PMH, B10 (tiebreak) prefers `pmh/8078` (open) over `pmh/1063` (closed).
- `covid 19`: COVID label `Defuncions per covid-19...` normalized contains `covid 19` → B1 +15. Token `covid` length ≥3 + matches `statistics_id` → B7 +20. base 10 + B6 +4 + B9 +0. ≈ 49. PMH ineligible (no `covid`). **COVID first.**
- `atur ocupacio`: e03 `Taxes d'activitat, ocupació i atur` → both tokens in label → base 10 + B6 +4 + B9 +48 (priority 4 × 12) = 62. **e03 first.**

### Within-statistic ordering (B10 as tiebreak)

For PMH/`sexe edat` after all bonuses settle, both `pmh/1063` and `pmh/8078` carry the same score and same priority. The comparator notices their `statistics_id` matches; B10 fires: `8078` (open `(2014–)`) ahead of `1063` (closed `(2000–2013)`). Across statistics — e.g., PMH vs CENSPH — B10 does NOT fire because `statistics_id` differs.

## Implementation outline

`src/sources/idescat/search-priority.ts` (new file): exports `STOP_TOKENS`, `CANONICAL_STATISTIC_PRIORITY`, `PRIORITY_BOOST_FACTOR`. No behavior, pure data.

`src/sources/idescat/search.ts` (modified, no public signature changes):

1. Update `normalizeSearchTerm` to strip Unicode punctuation.
2. Add private `stripStop(tokens)`, `buildPhraseHaystack(text)`, and `isOpenEndedSeries(rawLabel)`.
3. Add an internal type:

```ts
interface RankCandidate {
  entry: IdescatSearchIndexEntry;
  score: number;
  firstPos: number;
  priority: number;
  openSeries: boolean;
}
```

4. In `rankIdescatSearchResults`:
   - Compute `tokens`, `phraseTokens`, `phrase` once.
   - Per entry:
     - Build text-only haystack (label + statistic + node), normalized; split into `haystackTokens` for word-boundary checks.
     - Compute `normLabel`, `normNode`, `normStat` once.
     - Compute `phraseLabel`, `phraseNode` once.
     - Eligibility per token: `tokenSatisfied(token, entry)` — exact id-field match OR (length ≤2 word-boundary OR length ≥3 substring) against the text haystack.
     - Base score: per-token tier (5/3/1). For an id-satisfied token, add +5 as label-tier credit.
     - Apply B1/B2/B4/B5/B6/B7/B8/B9 per the table above. (B10 is NOT a score bonus; it's evaluated in the comparator.)
     - Compute `firstPos`, `priority`, `openSeries = isOpenEndedSeries(entry.label)`.
   - Filter ineligible.
   - Sort using the comparator above (score → priority → same-stat-openSeries → firstPos → localeCompare).

5. Project `RankCandidate` back to `{ entry, score }` for the existing public return shape used by `searchIdescatTables` (`search.ts:69-74`). Function signature unchanged.

## Tests (`tests/sources/idescat/search.test.ts`)

### Synthetic fixtures (extend existing 2 → 10)

Keep PMH (table_id `8078`) and ATUR-synthetic (table_id `2`). Add eight rows mirroring committed shards (labels and statistic strings copied verbatim from real `ca/*.ts` files):

- `pmh/1063` legacy series for B10 closed-range testing.
- `phre` row for `padro habitants` differentiation against PMH.
- `proj` row for `poblacio edat` priority test.
- `projl` row for `poblacio edat` priority test.
- `ep` row for `sexe edat` priority test (and 2-char id direct lookup).
- `covid` row with `covid-19` in label for `covid 19` phrase test.
- `eut` row for the original COVID/EUT regression coverage.
- `e03` row with label `Taxes d'activitat, ocupació i atur` for `atur ocupacio`.

### Discovery `it.each` (synthetic fixtures)

| Query                  | Top `statistics_id` | Bonus path                                    |
|------------------------|---------------------|------------------------------------------------|
| `poblacio edat`        | `pmh`               | B9 dominates over proj/projl/eut/covid        |
| `poblacio sexe edat`   | `pmh`               | B9 overcomes EP/CENSPH phrase advantage       |
| `padro habitants`      | `pmh`               | B9 over phre (B3 removed)                     |
| `sexe edat`            | `pmh`               | B9 over EP                                    |
| `sexe i edat`          | `pmh`               | symmetric stop-stripping                      |
| `covid 19`             | `covid`             | B1 phrase + B7                                 |
| `pmh`                  | `pmh` (only)        | field-aware id match + B7 + B9                 |
| `pmh 8078`             | `pmh/8078` (only)   | id + table_id both field-aware                 |
| `8078`                 | `pmh/8078` (only)   | bare table_id field-aware (no substring leak)  |
| `ep`                   | `ep`                | field-aware id (no B7 due to length); B9       |
| `atur ocupacio`        | `e03`               | base + B6 + B9                                |

### Negative tests

- `pmh atur` → empty.
- `covid atur` → empty.

### Within-statistic table-id assertion

For `sexe edat`, top result must have `statistics_id === "pmh"` AND `table_id === "8078"` (open-ended series), not `"1063"` (legacy). This guards B10.

### Real-index regression block (hermetic, offline)

Imports `../../../src/sources/idescat/search-index/ca.js`. Asserts:

- `query: "poblacio edat", lang: "ca"` → top `statistics_id === "pmh"`.
- `query: "poblacio sexe edat", lang: "ca"` → top `statistics_id === "pmh"`.
- `query: "padro habitants", lang: "ca"` → top `statistics_id === "pmh"`; first PHRE result index > first PMH index in the ranked list.
- `query: "sexe edat", lang: "ca"` → top `statistics_id === "pmh"`.
- `query: "sexe i edat", lang: "ca"` → top `statistics_id === "pmh"`.
- `query: "pmh", lang: "ca"` → all top-3 results have `statistics_id === "pmh"`.
- `query: "pmh 8078", lang: "ca"` → exactly one result with `table_id === "8078"`.
- `query: "8078", lang: "ca"` → exactly one result with `statistics_id === "pmh"` AND `table_id === "8078"` (asserts no node_id substring leakage from CEPH/18078 etc.).
- `query: "ep", lang: "ca"` → top `statistics_id === "ep"`. Top-10 are all EP rows (no CEPH/EEP substring leakage now that length-≤2 tokens use word-boundary).
- `query: "covid 19", lang: "ca"` → top `statistics_id === "covid"`.
- `query: "atur ocupacio", lang: "ca"` → top `statistics_id === "e03"`.
- `query: "pmh atur", lang: "ca"` → results empty.
- `query: "covid atur", lang: "ca"` → results empty.

### EN smoke

Imports `src/sources/idescat/search-index/en.js`. Asserts:

- `query: "municipal population register", lang: "en"` → top `statistics_id === "pmh"`. The EN PMH statistic is `Municipal Population Register` (verified at `src/sources/idescat/search-index/en/pmh.ts:11`); B8 (statistic coverage) + B9 (priority 5 × 12) handle this case even when PROJM rows compete on phrase-in-label.
- `query: "population sex age", lang: "en"` → top `statistics_id === "pmh"`. CENSPH/EP labels compact to `population sex age`; B9 +60 vs CENSPH +24 wins.

### Acknowledged-failure test (documented limitation)

A `describe.skip(...)` block (or commented `it.todo`) records queries the plan does NOT solve, so future work has a list:

- `taxa atur` (stemming/plural) → unsolved.
- `population by age` in EN (token `age` substring-matches `aged`) → not solved here; CENSPH may rank above PMH because of substring leakage.
- `atur comarca` (geo) → unsolved without index-shape change.

These are NOT failures of this plan; they are explicitly out-of-scope. Tests stay skipped until follow-up.

## Critical files

- Modify: `src/sources/idescat/search.ts` — `normalizeSearchTerm`, helpers, `rankIdescatSearchResults` body, sort comparator, internal `RankCandidate` type.
- Add: `src/sources/idescat/search-priority.ts` — `STOP_TOKENS`, `CANONICAL_STATISTIC_PRIORITY`, `PRIORITY_BOOST_FACTOR`.
- Modify: `tests/sources/idescat/search.test.ts` — fixtures, `it.each`, negative tests, table-id assertion, real-index `describe`, EN smoke, skipped follow-up tests.
- Read-only references:
  - `src/sources/idescat/search-index/types.ts` — entry shape.
  - `src/sources/idescat/search-index/ca.ts`, `en.ts`, `es.ts` — re-export shims.
  - `src/sources/idescat/search-index/{ca,en}/index.ts` — barrels.
  - `src/sources/idescat/search-index/ca/{pmh,phre,proj,projl,ep,covid,eut,e03,censph}.ts` — real label/statistic strings to copy into synthetic fixtures.
  - `src/sources/idescat/search-index/en/pmh.ts` — to confirm EN canonical statistic name.
  - `src/mcp/tools/idescat.ts:395-420` — output schema (unchanged).
  - `src/mcp/tools/idescat.ts:472` — input schema (no length minimum on `query`; documented).

## Risks & mitigations

- **`score` is part of `IdescatTableSearchCard` output**: numeric values shift with the new bonuses; schema is unchanged. Documented relative/debug semantics. Note in PR description.
- **`CANONICAL_STATISTIC_PRIORITY` is opinionated.** Small, reviewable, defaults to 0 for unknown ids. Reviewers can challenge entries during PR. Future-proofed by storing in its own file with `PRIORITY_BOOST_FACTOR` constant.
- **Stop-word list is locale-coupled.** A user querying just `"de"` returns AND-gate hits but no phrase boost. Acceptable.
- **2-character ids `ep`/`ee` get B9 priority and field-aware exact-id eligibility but not B7 (+20).** Direct id queries surface them at top via B9 dominance and word-boundary matching for the short-token case (no CEPH/EEP substring leakage).
- **Substring leakage on long tokens.** A length-≥3 token like `atur` still matches `atura` via `String.includes`. This is preserved existing behavior (single-token queries on common Catalan stems work as today). B9 priority compensates if a non-canonical row matches by coincidence.
- **`taxa atur` removed from goals.** Stemming/plural normalization is out of scope; rank-only fix cannot work. Documented in skipped tests.
- **`atur comarca`-style geo queries** require an index-shape change. Out of scope.
- **Performance**: ~15 ms per real-index search (round-1 measurement). Well within MCP request budget. If latency matters later, precompute normalized fields at module load.
- **Open-ended series detection (B10)** uses regex `/\(\d{4}\s*[–\-]\s*\)/u` against the raw label. May miss labels that omit the parens. Conservative on purpose; the +2 weight is small.
- **PRIORITY_BOOST_FACTOR=12 chosen empirically** based on round-4 simulation against the committed corpus. PMH vs CENSPH/EP `poblacio sexe edat`: CENSPH max non-priority stack is +33 (B1+B2+B4+B5+B6); PMH non-priority stack is +13 (B4+B5+B6 only because phrase is broken by `a 1 de gener`). Gap is 20 points. Priority-5 vs priority-2 differential at factor 12 is 36 points. Net PMH advantage: 16 points. Robust to future query patterns that push the non-priority gap up to ~30 points.

## Verification

1. `npm test` — vitest runs synthetic + negative + table-id + real-index + EN tests; all must pass.
2. `npm run typecheck` — no public-signature changes; should be a no-op.
3. `npm run lint` — Biome on the new helper code (cSpell IDE diagnostics not enforced by lint).
4. `npm run smoke` — `searchIdescatTables` end-to-end; confirms no runtime regression.
5. `npm run package:size` — code-only delta; expect ≤ +3 KB (priority map + stop-word set + helpers + open-series regex).
6. `npm run check` — umbrella before commit.
7. Optional one-off (not committed): print top-5 results for `poblacio edat`, `poblacio sexe edat`, `padro habitants`, `sexe edat`, `pmh`, `pmh 8078`, `ep`, `covid 19`, `atur ocupacio` against the real CA index and eyeball them.

## Revision history

### Round 1 (after first codex critique)

- Normalizer extended to replace punctuation with spaces.
- Added `buildPhraseHaystack` with CA/ES/EN stop-word stripping (haystack only).
- Added eligibility short-circuit for `statistics_id` (OR-style).
- Added B8 statistic-coverage bonus + statistic-compactness tiebreak.
- Replaced `min(token positions)` with first-query-token position.
- Replaced `atur comarca` with `atur ocupacio`; rewrote `covid residencies` to `covid 19`.
- Added hermetic real-index regression block + EN smoke.
- Dropped sub-millisecond performance claim. Documented `score` value drift.

### Round 2 (after second codex critique)

- Replaced statistic-compactness tiebreak with curated `CANONICAL_STATISTIC_PRIORITY` lookup.
- Reordered tiebreak chain to `priority before first-pos`.
- Removed B3 (phrase-in-statistic; was handing PHRE the win for `padro habitants`).
- Tightened id eligibility from OR to AND-with-text.
- Stop-word stripping made symmetric (query and haystack).
- Punctuation normalization uses `\p{P}` (Unicode property).
- Documented length-≥3 id gate consistently; flagged limitation for ep/ee.
- Made `taxa atur` an explicit non-goal.
- Strengthened EN smoke assertion to require `statistics_id === "pmh"`.
- Added negative tests `pmh atur` and `covid atur`.
- Added `proj`, `projl`, `ep`, `phre` synthetic fixtures.
- Defined explicit `RankCandidate` internal type.
- Promoted curated lists to `search-priority.ts` module.

### Round 3 (after third codex critique)

- **B9 added: priority is now part of the score, not just a tiebreak.** `score += priority × 8`. Reason: round-3 critique §1 — for `poblacio sexe edat`, EP labels compact to the literal phrase, earning B1+B4+B6 stacks ~22 points above PMH's score. Priority-as-tiebreak alone could not overturn this. With B9, PMH's +40 vs EP's +16 closes the gap and PMH wins on score.
- **Length-≥3 gate dropped from id eligibility; ids included in haystack instead.** Reason: round-3 critique §3 — `ep poblacio` was returning CEPH (substring leakage `dependents`) instead of EP. Including `statistics_id` in the haystack lets `ep` satisfy itself directly; substring leakage is mitigated by B9 priority (EP=2 → +16 > CEPH=0 → +0).
- **`table_id` and `node_id` added to haystack.** Reason: round-3 critique §4 — mixed-identifier queries like `pmh 8078`, `covid 15252` were returning empty. Now both id and table_id satisfy via haystack; AND-with-text invariant preserved.
- **B10 added: open-ended series bonus (+2)**. Reason: round-3 critique §5 — within-statistic ordering ranked legacy series (e.g. PMH/1063 `2000–2013`) above current series (PMH/8078 `2014–`) for `sexe edat` because of `localeCompare` lexicography. B10 prefers open-ended series with a small bonus.
- **B7 length-≥3 gate retained** but only for the +20 bonus, not eligibility. 2-char ids (ep, ee) get B9 priority and base credit but not the +20 boost — sensible because the boost compensates for ambiguous short tokens with strong canonical signal.
- **Tiebreak chain text deduplicated.** Reason: round-3 critique §0 — round-2 plan had two contradictory tiebreak orderings in different sections.
- **Worked-example numeric totals trimmed** (B2/B5 stacking explicitly elided as illustrative). Reason: round-3 critique §6 — round-2 examples missed bonuses, making arithmetic hard to follow without changing conclusions.
- **Fixture count corrected** to "2 → 10" (was incorrectly stated as "2 → 9"). Round-3 critique §7.
- **Added table-id-level assertion** for `sexe edat` → `pmh/8078` (B10 verification). Round-3 critique §5.
- **Added skipped acknowledged-failure tests** for `taxa atur`, `population by age` (EN substring leakage `aged`), and `atur comarca`. Round-3 critique "What I would still test" — explicit non-goals listed in tests so follow-up is visible.
- **Added `pmh 8078` and `ep` to discovery and real-index tests.** Round-3 critique §3 and §4.

### Round 4 (after fourth codex critique)

- **`PRIORITY_BOOST_FACTOR` raised from 8 to 12.** Reason: round-4 simulation showed CENSPH/EP earned +33 from full B1+B2+B4+B5+B6 stacking on `poblacio sexe edat`, while PMH earned only +13 because `a 1 de gener` interrupts the phrase. The 20-point non-priority gap exceeded the 24-point priority differential at factor 8 (PMH 40 vs CENSPH 16). Factor 12 produces a 36-point priority differential, restoring a 16-point PMH advantage.
- **B10 demoted from score bonus (+2) to within-same-`statistics_id` tiebreak.** Reason: round-4 critique §3 — as a global score bonus, B10 gave CENSPH `(2011–)` an unintended +2 over PMH `(2014–)`-equivalent rows from other statistics, widening the gap on `poblacio sexe edat`. As a tiebreak, B10 still distinguishes `pmh/8078` from `pmh/1063` without spilling cross-statistic.
- **Field-aware id matching replaces id-in-haystack.** Round-4 critique §4 and §5: putting `statistics_id`/`table_id`/`node_id` into the substring haystack caused two leaks — `ep` matched CEPH via `dependents` substring (1 substring at offset N), and bare numeric `8078` matched CEPH/18078 via `node_id` substring. Fix: text haystack stays text-only; ids are checked as exact-token equality. Length-≤2 tokens use word-boundary against haystack tokens (cleans up `ep` total count). Length-≥3 tokens keep substring (preserves existing `atur`/`padro` behavior).
- **Added discovery test `8078`** asserting bare numeric id returns exactly PMH/8078 (round-4 critique §5).
- **Added EN real-index assertion `population sex age`** (round-4 critique §2). The single-EN-smoke approach was too narrow.
- **Updated worked examples** to reflect `BOOST_FACTOR=12` and B10-as-tiebreak.
