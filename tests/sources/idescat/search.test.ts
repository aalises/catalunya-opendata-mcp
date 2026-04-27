import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeSearchTerm,
  rankIdescatSearchResults,
  searchIdescatTables,
} from "../../../src/sources/idescat/search.js";
import {
  analyzeIdescatDiscoveryQuery,
  orderGeoCandidates,
} from "../../../src/sources/idescat/search-geography.js";
import caEntries, {
  generatedAt as caGeneratedAt,
} from "../../../src/sources/idescat/search-index/ca.js";
import enEntries from "../../../src/sources/idescat/search-index/en.js";
import esEntries from "../../../src/sources/idescat/search-index/es.js";
import type { IdescatSearchIndexEntry } from "../../../src/sources/idescat/search-index/types.js";
import { buildIdescatSemanticTopicGroups } from "../../../src/sources/idescat/search-semantics.js";

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
    geo_ids: ["cat", "com", "mun"],
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
    geo_ids: ["com"],
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
    geo_ids: ["cat", "com"],
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
    geo_ids: ["cat"],
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
    geo_ids: ["cat"],
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
    geo_ids: ["cat"],
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
    geo_ids: ["cat"],
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
    geo_ids: ["cat"],
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
    geo_ids: ["cat"],
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
    // Fictional "com": real e03 only exposes "cat". Synthetic so the geo-boost
    // branch is exercised; real-CA-index assertions below cover production shape.
    geo_ids: ["cat", "com"],
    source_url: "https://api.idescat.cat/taules/v2/e03/22274/26671?lang=ca",
  },
  {
    statistics_id: "afi",
    node_id: "21420",
    table_id: "25318",
    label:
      "Afiliacions a la Seguretat Social segons residència padronal de l'afiliat. Per sector d'activitat econòmica",
    ancestor_labels: {
      statistic: "Afiliats i afiliacions a la Seguretat Social",
      node: "Afiliacions per sector d'activitat econòmica",
    },
    geo_ids: ["cat", "com"],
    source_url: "https://api.idescat.cat/taules/v2/afi/21420/25318?lang=ca",
  },
  {
    statistics_id: "afi",
    node_id: "21424",
    table_id: "25320",
    label:
      "Afiliacions a la Seguretat Social per compte d'altri segons residència padronal de l'afiliat. Per secció d'activitat econòmica",
    ancestor_labels: {
      statistic: "Afiliats i afiliacions a la Seguretat Social",
      node: "Afiliacions per secció d'activitat econòmica",
    },
    geo_ids: ["cat"],
    source_url: "https://api.idescat.cat/taules/v2/afi/21424/25320?lang=ca",
  },
  {
    statistics_id: "rfdbc",
    node_id: "13301",
    table_id: "14148",
    label: "RFDB i RFDB per habitant. Revisió estadística 2019",
    ancestor_labels: {
      statistic: "Renda familiar disponible bruta territorial",
      node: "RFDB i RFDB per habitant",
    },
    geo_ids: ["cat", "com", "mun"],
    source_url: "https://api.idescat.cat/taules/v2/rfdbc/13301/14148?lang=ca",
  },
  {
    statistics_id: "ispat",
    node_id: "14664",
    table_id: "20433",
    label: "Despesa en R+D interna feta a Catalunya. Per naturalesa de la despesa",
    ancestor_labels: {
      statistic: "Indicadors sectorials",
      node: "Despesa per naturalesa de la despesa",
    },
    geo_ids: ["com"],
    source_url: "https://api.idescat.cat/taules/v2/ispat/14664/20433?lang=ca",
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

  it("builds semantic topic groups greedily without keeping stop tokens as requirements", () => {
    const rendaGroups = buildIdescatSemanticTopicGroups(["renda", "per", "capita"]);
    const rendaAlternatives = rendaGroups[0]?.alternatives.map((alternative) =>
      alternative.tokens.join(" "),
    );
    const stopwordPhraseGroups = buildIdescatSemanticTopicGroups(["renda", "de", "la", "familia"]);
    const stopwordPhraseAlternatives = stopwordPhraseGroups[0]?.alternatives.map((alternative) =>
      alternative.tokens.join(" "),
    );

    expect(rendaGroups).toHaveLength(1);
    expect(rendaGroups[0]?.originalTokens).toEqual(["renda", "per", "capita"]);
    expect(rendaAlternatives).toContain("rfdb habitant");
    expect(stopwordPhraseGroups).toHaveLength(1);
    expect(stopwordPhraseGroups[0]?.originalTokens).toEqual(["renda", "de", "la", "familia"]);
    expect(stopwordPhraseAlternatives).toContain("rfdb");

    expect(
      buildIdescatSemanticTopicGroups(["poblacio", "per", "edat"]).map(
        (group) => group.originalTokens,
      ),
    ).toEqual([["poblacio"], ["edat"]]);
  });

  it("analyzes geography intent without keeping geo words as topic tokens", () => {
    expect(analyzeIdescatDiscoveryQuery("poblacio comarca")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["com"],
      geoTokens: ["comarca"],
    });
    expect(analyzeIdescatDiscoveryQuery("poblacio seccio censal seccio censal")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["sec"],
      geoTokens: ["seccio", "censal", "seccio", "censal"],
    });
    expect(analyzeIdescatDiscoveryQuery("municipi")).toEqual({
      topicTokens: [],
      requestedGeoIds: ["mun"],
      geoTokens: ["municipi"],
    });
    expect(analyzeIdescatDiscoveryQuery("poblacio municipal")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["mun"],
      geoTokens: ["municipal"],
    });
    expect(analyzeIdescatDiscoveryQuery("atur Maresme")).toEqual({
      topicTokens: ["atur"],
      requestedGeoIds: ["com"],
      geoTokens: ["maresme"],
    });
    expect(analyzeIdescatDiscoveryQuery("poblacio Barcelonès")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["com"],
      geoTokens: ["barcelones"],
    });
    expect(analyzeIdescatDiscoveryQuery("poblacio Barcelones")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["com"],
      geoTokens: ["barcelones"],
    });
    expect(analyzeIdescatDiscoveryQuery("renda Girona")).toEqual({
      topicTokens: ["renda"],
      requestedGeoIds: ["prov", "mun"],
      geoTokens: ["girona"],
    });
    expect(analyzeIdescatDiscoveryQuery("poblacio l'Ametlla de Mar")).toEqual({
      topicTokens: ["poblacio"],
      requestedGeoIds: ["mun"],
      geoTokens: ["l", "ametlla", "de", "mar"],
    });
  });

  it("orders requested geo candidates first without exposing unknown ordering drift", () => {
    expect(orderGeoCandidates(["mun", "cat", "com"], ["com"])).toEqual(["com", "cat", "mun"]);
    expect(orderGeoCandidates(["zzz", "cat", "aaa"], [])).toEqual(["cat", "aaa", "zzz"]);
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
    ["taxa atur", "e03"],
    ["paro", "e03"],
    ["poblacio comarca", "pmh"],
    ["poblacio municipi", "pmh"],
    ["poblacio municipal", "pmh"],
    ["afiliacions comarca", "afi"],
    ["atur comarca", "e03"],
    ["paro comarca", "e03"],
    ["atur municipal", "e03"],
    ["atur Maresme", "e03"],
    ["renda Girona", "rfdbc"],
    ["renda per capita Maresme", "rfdbc"],
  ])("puts the canonical statistic first for %s", (query, statisticsId) => {
    const results = rankIdescatSearchResults(entries, query);

    expect(results[0]?.entry.statistics_id).toBe(statisticsId);
  });

  it.each([
    ["poblacio comarca", "com"],
    ["poblacio municipi", "mun"],
    ["poblacio municipal", "mun"],
    ["poblacio Barcelonès", "com"],
    ["renda Girona", "mun"],
    ["renda per capita Maresme", "com"],
  ])("keeps the requested geography first for %s", (query, geoId) => {
    const analysis = analyzeIdescatDiscoveryQuery(query);
    const results = rankIdescatSearchResults(entries, query, analysis);
    const geoIds = results[0]?.entry.geo_ids ?? [];

    expect(orderGeoCandidates(geoIds, analysis.requestedGeoIds)[0]).toBe(geoId);
  });

  it("prefers same-topic rows that support the requested geography", () => {
    const results = rankIdescatSearchResults(entries, "afiliacions comarca");

    expect(results[0]?.entry.statistics_id).toBe("afi");
    expect(results[0]?.entry.table_id).toBe("25318");
    expect(results[0]?.entry.geo_ids).toContain("com");
  });

  it("does not geo-boost substring-only topic matches", () => {
    const results = rankIdescatSearchResults(entries, "atur comarca");

    expect(results[0]?.entry.statistics_id).toBe("e03");
    expect(results[0]?.entry.label).toContain("atur");
    expect(results.findIndex((result) => result.entry.statistics_id === "ispat")).toBeGreaterThan(
      0,
    );
  });

  it("keeps canonical priority ahead of lower-priority original-token alias matches", () => {
    const e03Entry = entries.find((entry) => entry.statistics_id === "e03");

    if (!e03Entry) {
      throw new Error("Expected synthetic e03 entry.");
    }

    const nonCanonicalParo: IdescatSearchIndexEntry = {
      statistics_id: "custom",
      node_id: "1",
      table_id: "1",
      label: "Paro registrat",
      ancestor_labels: {
        statistic: "Mercat de treball",
        node: "Paro",
      },
      geo_ids: ["cat"],
      source_url: "https://api.idescat.cat/taules/v2/custom/1/1?lang=ca",
    };

    const results = rankIdescatSearchResults([nonCanonicalParo, e03Entry], "paro");

    expect(results[0]?.entry.statistics_id).toBe("e03");
    expect(results[1]?.entry.statistics_id).toBe("custom");
  });

  it("returns no results for geo-only queries", () => {
    expect(rankIdescatSearchResults(entries, "comarca")).toEqual([]);
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
      ["taxa atur", "e03"],
      ["paro", "e03"],
      ["paro comarca", "e03"],
      ["poblacio comarca", "pmh"],
      ["poblacio municipal", "pmh"],
      ["poblacio Barcelonès", "pmh"],
      ["renda Girona", "rfdbc"],
      ["renda de la familia", "rfdbc"],
      ["renda per capita Maresme", "rfdbc"],
    ])("ranks %s with %s first", (query, statisticsId) => {
      const results = rankIdescatSearchResults(caEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });

    it.each([
      ["atur ocupacio", "e03"],
      ["padro habitants", "pmh"],
      ["sexe edat", "pmh"],
    ])("preserves existing two-token ranking quality for %s", (query, statisticsId) => {
      const results = rankIdescatSearchResults(caEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });

    it("exposes real geo hints for geo-aware population discovery", async () => {
      const result = await searchIdescatTables({ query: "poblacio comarca", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("pmh");
      expect(first?.geo_candidates).toContain("com");
      expect(first?.geo_candidates?.[0]).toBe("com");
      expect(first).not.toHaveProperty("geo_ids");
    });

    it("exposes municipal adjective geo hints for real population discovery", async () => {
      const result = await searchIdescatTables({ query: "poblacio municipal", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("pmh");
      expect(first?.geo_candidates).toContain("mun");
      expect(first?.geo_candidates?.[0]).toBe("mun");
    });

    it("uses named comarques as geo intent for real population discovery", async () => {
      const result = await searchIdescatTables({ query: "poblacio Barcelonès", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("pmh");
      expect(first?.geo_candidates).toContain("com");
      expect(first?.geo_candidates?.[0]).toBe("com");
    });

    it("uses ambiguous municipality/province names as recoverable geo intent", async () => {
      const result = await searchIdescatTables({ query: "renda Girona", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("rfdbc");
      expect(first?.geo_candidates).not.toBeNull();
      expect(first?.geo_candidates).toContain("mun");
      expect(first?.geo_candidates?.[0]).toBe("mun");
    });

    it("keeps real atur comarca discovery recoverable even when geography is unavailable", async () => {
      const result = await searchIdescatTables({ query: "atur comarca", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("e03");
      expect(first?.geo_candidates).not.toBeNull();
    });

    it("keeps real paro comarca discovery recoverable via semantic aliases", async () => {
      const result = await searchIdescatTables({ query: "paro comarca", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("e03");
      expect(first?.geo_candidates).not.toBeNull();
    });

    it("keeps real atur municipal discovery recoverable even when geography is unavailable", async () => {
      const result = await searchIdescatTables({ query: "atur municipal", limit: 1 }, config);
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("e03");
      expect(first?.geo_candidates).not.toBeNull();
    });

    it("uses semantic aliases for real renda per capita place discovery", async () => {
      const result = await searchIdescatTables(
        { query: "renda per capita Maresme", limit: 1 },
        config,
      );
      const first = result.data.results[0];

      expect(first?.statistics_id).toBe("rfdbc");
      expect(first?.geo_candidates).not.toBeNull();
      expect(first?.geo_candidates?.[0]).toBe("com");
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
      ["family income", "rfdbc"],
      ["income of household", "rfdbc"],
    ])("ranks %s with %s first", (query, statisticsId) => {
      const results = rankIdescatSearchResults(enEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });
  });

  describe("real ES index regressions", () => {
    it.each([
      ["renta familiar", "rfdbc"],
      ["renta de la familia", "rfdbc"],
    ])("uses semantic aliases for Spanish renda phrasing: %s", (query, statisticsId) => {
      const results = rankIdescatSearchResults(esEntries, query);

      expect(results[0]?.entry.statistics_id).toBe(statisticsId);
    });
  });

  describe.skip("acknowledged search limitations", () => {
    it("does not solve English substring leakage for population by age", () => {
      expect(rankIdescatSearchResults(enEntries, "population by age")[0]?.entry.statistics_id).toBe(
        "pmh",
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
