import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeSearchTerm,
  rankIdescatSearchResults,
  searchIdescatTables,
} from "../../../src/sources/idescat/search.js";
import caEntries, {
  generatedAt as caGeneratedAt,
} from "../../../src/sources/idescat/search-index/ca.js";
import enEntries from "../../../src/sources/idescat/search-index/en.js";
import type { IdescatSearchIndexEntry } from "../../../src/sources/idescat/search-index/types.js";

const entries: IdescatSearchIndexEntry[] = [
  {
    statistics_id: "pmh",
    node_id: "1180",
    table_id: "8078",
    label: "Població a 1 de gener. Per sexe i edat any a any (2014–)",
    ancestor_labels: {
      statistic: "Padró municipal d'habitants",
      node: "Població a 1 de gener. Per sexe i edat any a any",
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
  {
    statistics_id: "pmh",
    node_id: "1180",
    table_id: "1063",
    label: "Població a 1 de gener. Per sexe i edat any a any (2000–2013)",
    ancestor_labels: {
      statistic: "Padró municipal d'habitants",
      node: "Població a 1 de gener. Per sexe i edat any a any",
    },
    source_url: "https://api.idescat.cat/taules/v2/pmh/1180/1063?lang=ca",
  },
  {
    statistics_id: "phre",
    node_id: "21174",
    table_id: "25005",
    label:
      "Noves inscripcions de població resident a l'estranger. Per país de residència (1.000 residents o més) i lloc de naixement (agregat) (2025)",
    ancestor_labels: {
      statistic: "Padró d'habitants residents a l'estranger",
      node: "Noves inscripcions de població resident a l'estranger. Per país de residència (1.000 residents o més) i lloc de naixement (agregat)",
    },
    source_url: "https://api.idescat.cat/taules/v2/phre/21174/25005?lang=ca",
  },
  {
    statistics_id: "proj",
    node_id: "14560",
    table_id: "15410",
    label: "Població projectada a 1 de gener per sexe i edat. Escenari mitjà (base 2021)",
    ancestor_labels: {
      statistic: "Projeccions de població",
      node: "Població projectada a 1 de gener per sexe i edat. Escenari mitjà (base 2021)",
    },
    source_url: "https://api.idescat.cat/taules/v2/proj/14560/15410?lang=ca",
  },
  {
    statistics_id: "projl",
    node_id: "21011",
    table_id: "24904",
    label:
      "Població projectada a 1 de gener (base 2024). Per sexe, edat i grandària de la llar. Escenari mitjà",
    ancestor_labels: {
      statistic: "Projeccions de llars",
      node: "Població projectada a 1 de gener (base 2024). Per sexe, edat i grandària de la llar. Escenari mitjà",
    },
    source_url: "https://api.idescat.cat/taules/v2/projl/21011/24904?lang=ca",
  },
  {
    statistics_id: "ep",
    node_id: "9123",
    table_id: "20149",
    label: "Població. Per sexe i edat (S1/2012–S1/2025)",
    ancestor_labels: {
      statistic: "Estimacions de població",
      node: "Població. Per sexe i edat",
    },
    source_url: "https://api.idescat.cat/taules/v2/ep/9123/20149?lang=ca",
  },
  {
    statistics_id: "covid",
    node_id: "14184",
    table_id: "15254",
    label: "Defuncions per covid-19. Per sexe i edat en grans grups",
    ancestor_labels: {
      statistic: "Estadística de la covid-19",
      node: "Defuncions per covid-19. Per sexe i edat en grans grups",
    },
    source_url: "https://api.idescat.cat/taules/v2/covid/14184/15254?lang=ca",
  },
  {
    statistics_id: "eut",
    node_id: "1014",
    table_id: "951",
    label:
      "Població que va participar en activitats culturals i de lleure en el mes anterior. Per sexe i edat en grans grups",
    ancestor_labels: {
      statistic: "Enquesta de l'ús del temps",
      node: "Població que va participar en activitats culturals i de lleure en el mes anterior. Per sexe i edat en grans grups",
    },
    source_url: "https://api.idescat.cat/taules/v2/eut/1014/951?lang=ca",
  },
  {
    statistics_id: "e03",
    node_id: "22274",
    table_id: "26671",
    label: "Taxes d'activitat, ocupació i atur",
    ancestor_labels: {
      statistic: "Estimació mensual de la població activa",
      node: "Taxes d'activitat, ocupació i atur",
    },
    source_url: "https://api.idescat.cat/taules/v2/e03/22274/26671?lang=ca",
  },
];

const config = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  socrataAppToken: undefined,
} as const;

describe("rankIdescatSearchResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes accents and punctuation and requires all query tokens", () => {
    expect(normalizeSearchTerm(" Població   COMARCÀ ")).toBe("poblacio comarca");
    expect(normalizeSearchTerm("Padró d'habitants covid-19 S2/1986–S2/2011")).toBe(
      "padro d habitants covid 19 s2 1986 s2 2011",
    );

    const results = rankIdescatSearchResults(entries, "padro edat");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.entry.table_id).toBe("8078");
  });

  it("ranks own-label matches for narrow non-priority queries", () => {
    const results = rankIdescatSearchResults(entries, "registrat comarca");

    expect(results[0]?.entry.table_id).toBe("2");
  });

  it.each([
    ["poblacio edat", "pmh"],
    ["poblacio sexe edat", "pmh"],
    ["padro habitants", "pmh"],
    ["sexe edat", "pmh"],
    ["sexe i edat", "pmh"],
    ["covid 19", "covid"],
    ["ep", "ep"],
    ["atur ocupacio", "e03"],
  ])("puts the canonical statistic first for %s", (query, statisticsId) => {
    const results = rankIdescatSearchResults(entries, query);

    expect(results[0]?.entry.statistics_id).toBe(statisticsId);
  });

  it.each(["pmh", "pmh 8078", "8078"])("matches direct identifiers for %s", (query) => {
    const results = rankIdescatSearchResults(entries, query);

    expect(results).toHaveLength(query === "pmh" ? 2 : 1);
    expect(results.every((result) => result.entry.statistics_id === "pmh")).toBe(true);
    if (query !== "pmh") {
      expect(results[0]?.entry.table_id).toBe("8078");
    }
  });

  it("prefers the open-ended table within a statistic", () => {
    const results = rankIdescatSearchResults(entries, "sexe edat");

    expect(results[0]?.entry.statistics_id).toBe("pmh");
    expect(results[0]?.entry.table_id).toBe("8078");
  });

  it.each(["pmh atur", "covid atur"])("returns no mixed-id false positives for %s", (query) => {
    expect(rankIdescatSearchResults(entries, query)).toEqual([]);
  });

  describe("real CA index regressions", () => {
    it.each([
      ["poblacio edat", "pmh"],
      ["poblacio sexe edat", "pmh"],
      ["padro habitants", "pmh"],
      ["sexe edat", "pmh"],
      ["sexe i edat", "pmh"],
      ["ep", "ep"],
      ["covid 19", "covid"],
      ["atur ocupacio", "e03"],
    ])("ranks %s with %s first", (query, statisticsId) => {
      const results = rankIdescatSearchResults(caEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });

    it("keeps PHRE behind PMH for padro habitants", () => {
      const results = rankIdescatSearchResults(caEntries, "padro habitants");
      const firstPmh = results.findIndex((result) => result.entry.statistics_id === "pmh");
      const firstPhre = results.findIndex((result) => result.entry.statistics_id === "phre");

      expect(firstPmh).toBe(0);
      expect(firstPhre).toBeGreaterThan(firstPmh);
    });

    it("keeps direct PMH id lookup scoped to PMH", () => {
      const results = rankIdescatSearchResults(caEntries, "pmh");

      expect(results.slice(0, 3).every((result) => result.entry.statistics_id === "pmh")).toBe(
        true,
      );
    });

    it.each(["pmh 8078", "8078"])("matches only PMH table 8078 for %s", (query) => {
      const results = rankIdescatSearchResults(caEntries, query);

      expect(results).toHaveLength(1);
      expect(results[0]?.entry.statistics_id).toBe("pmh");
      expect(results[0]?.entry.table_id).toBe("8078");
    });

    it("keeps short EP id lookup from leaking into other statistics", () => {
      const results = rankIdescatSearchResults(caEntries, "ep");

      expect(results[0]?.entry.statistics_id).toBe("ep");
      expect(results.slice(0, 10).every((result) => result.entry.statistics_id === "ep")).toBe(
        true,
      );
    });

    it.each(["pmh atur", "covid atur"])("returns no results for %s", (query) => {
      expect(rankIdescatSearchResults(caEntries, query)).toEqual([]);
    });
  });

  describe("real EN index regressions", () => {
    it.each([
      ["municipal population register", "pmh"],
      ["population sex age", "pmh"],
    ])("ranks %s with %s first", (query, statisticsId) => {
      const results = rankIdescatSearchResults(enEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });
  });

  describe.skip("acknowledged search limitations", () => {
    it("does not solve stemming for taxa atur", () => {
      expect(rankIdescatSearchResults(caEntries, "taxa atur")[0]?.entry.statistics_id).toBe("e03");
    });

    it("does not solve English substring leakage for population by age", () => {
      expect(rankIdescatSearchResults(enEntries, "population by age")[0]?.entry.statistics_id).toBe(
        "pmh",
      );
    });

    it("does not solve geo-style atur comarca queries", () => {
      expect(rankIdescatSearchResults(caEntries, "atur comarca")[0]?.entry.statistics_id).toBe(
        "e03",
      );
    });
  });

  it("logs a non-blocking stale-index warning", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2028-04-27T00:00:00.000Z"));
    const warn = vi.fn();

    const result = await searchIdescatTables(
      {
        query: "poblacio",
        lang: "ca",
      },
      config,
      {
        logger: {
          child: () => {
            throw new Error("child should not be called");
          },
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
        },
      },
    );

    expect(result.data.results.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith("index_stale", {
      source: "idescat",
      generatedAt: caGeneratedAt,
      lang: "ca",
    });
  });
});
