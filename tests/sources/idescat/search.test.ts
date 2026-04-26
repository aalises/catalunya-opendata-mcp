import { describe, expect, it } from "vitest";

import {
  normalizeSearchTerm,
  rankIdescatSearchResults,
} from "../../../src/sources/idescat/search.js";
import type { IdescatSearchIndexEntry } from "../../../src/sources/idescat/search-index/types.js";

const entries: IdescatSearchIndexEntry[] = [
  {
    statistics_id: "pmh",
    node_id: "1180",
    table_id: "8078",
    label: "Població a 1 de gener. Per sexe i edat any a any",
    ancestor_labels: {
      statistic: "Padró municipal d'habitants",
      node: "Població per edat",
    },
    source_url: "https://api.idescat.cat/taules/v2/pmh/1180/8078?lang=ca",
  },
  {
    statistics_id: "atur",
    node_id: "1",
    table_id: "2",
    label: "Atur registrat per comarca",
    ancestor_labels: {
      statistic: "Mercat de treball",
      node: "Atur",
    },
    source_url: "https://api.idescat.cat/taules/v2/atur/1/2?lang=ca",
  },
];

describe("rankIdescatSearchResults", () => {
  it("normalizes accents and requires all query tokens", () => {
    expect(normalizeSearchTerm(" Població   COMARCÀ ")).toBe("poblacio comarca");

    const results = rankIdescatSearchResults(entries, "padro edat");

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.table_id).toBe("8078");
  });

  it("ranks own-label matches above ancestor-only matches", () => {
    const results = rankIdescatSearchResults(entries, "atur");

    expect(results[0]?.entry.table_id).toBe("2");
  });
});
