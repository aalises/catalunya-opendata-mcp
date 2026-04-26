import { describe, expect, it } from "vitest";

import {
  extractTupleFromUrl,
  parseIdescatTableMetadata,
} from "../../../src/sources/idescat/metadata.js";

describe("extractTupleFromUrl", () => {
  it("decodes absolute Tables v2 hrefs", () => {
    expect(extractTupleFromUrl("https://api.idescat.cat/taules/v2/pmh/1180/8078/com")).toEqual({
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "com",
    });
  });

  it("returns null for hrefs outside the Tables v2 namespace", () => {
    expect(extractTupleFromUrl("https://example.com/other")).toBeNull();
  });

  it("rejects hrefs with extra path segments past the table tuple", () => {
    // /data is the data endpoint, not a metadata table tuple. Without this
    // guard a same-table /data link would be classified as a related table.
    expect(
      extractTupleFromUrl("https://api.idescat.cat/taules/v2/pmh/1180/8078/com/data"),
    ).toBeNull();
  });

  it("rejects non-IDESCAT hosts even when the path shape matches", () => {
    expect(extractTupleFromUrl("https://example.com/taules/v2/pmh/1180/8078/com")).toBeNull();
  });
});

describe("parseIdescatTableMetadata", () => {
  it("does not fabricate license_or_terms when the dataset has no terms link", () => {
    const metadata = parseIdescatTableMetadata(
      {
        version: "2.0",
        class: "dataset",
        label: "Test",
        id: ["GEO"],
        size: [1],
        dimension: {
          GEO: {
            label: "g",
            category: { index: ["X"], label: { X: "x" } },
          },
        },
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "ca",
      },
      new URL("https://api.idescat.cat/taules/v2/pmh/1180/8078/com?lang=ca"),
    );

    expect(metadata.terms_url).toBeUndefined();
    expect(metadata.provenance.license_or_terms).toBeNull();
  });

  it("populates terms_url and license_or_terms from a license link relation", () => {
    const metadata = parseIdescatTableMetadata(
      {
        version: "2.0",
        class: "dataset",
        label: "Test",
        id: ["GEO"],
        size: [1],
        dimension: {
          GEO: { label: "g", category: { index: ["X"], label: { X: "x" } } },
        },
        link: {
          license: { href: "https://www.idescat.cat/dev/api/?lang=en#terms" },
        },
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "en",
      },
      new URL("https://api.idescat.cat/taules/v2/pmh/1180/8078/com?lang=en"),
    );

    expect(metadata.terms_url).toBe("https://www.idescat.cat/dev/api/?lang=en#terms");
    expect(metadata.provenance.license_or_terms).toBe(
      "https://www.idescat.cat/dev/api/?lang=en#terms",
    );
  });

  it("populates dimension-level default unit from extension.unit", () => {
    const metadata = parseIdescatTableMetadata(
      {
        version: "2.0",
        class: "dataset",
        label: "Test",
        id: ["CONCEPT"],
        size: [1],
        dimension: {
          CONCEPT: {
            label: "c",
            category: { index: ["POP"], label: { POP: "Population" } },
            extension: { unit: { decimals: 0, symbol: "people" } },
          },
        },
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "ca",
      },
      new URL("https://api.idescat.cat/taules/v2/pmh/1180/8078/com?lang=ca"),
    );

    expect(metadata.dimensions[0]?.unit).toEqual({ decimals: 0, symbol: "people" });
  });

  it("preserves JSON-stat category hierarchy metadata", () => {
    const metadata = parseIdescatTableMetadata(
      {
        version: "2.0",
        class: "dataset",
        label: "Population by territory",
        id: ["GEO"],
        size: [3],
        role: {
          geo: ["GEO"],
        },
        dimension: {
          GEO: {
            label: "territory",
            category: {
              index: ["CAT", "01", "02"],
              label: {
                CAT: "Catalonia",
                "01": "Alt Camp",
                "02": "Alt Emporda",
              },
              child: {
                CAT: ["01", "02"],
              },
            },
          },
        },
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "en",
      },
      new URL("https://api.idescat.cat/taules/v2/pmh/1180/8078/com?lang=en"),
    );

    expect(metadata.dimensions[0]?.categories).toEqual([
      {
        id: "CAT",
        index: 0,
        label: "Catalonia",
      },
      {
        id: "01",
        index: 1,
        label: "Alt Camp",
        parent: "CAT",
      },
      {
        id: "02",
        index: 2,
        label: "Alt Emporda",
        parent: "CAT",
      },
    ]);
  });
});
