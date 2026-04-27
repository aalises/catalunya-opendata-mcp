import { describe, expect, it, vi } from "vitest";
import {
  crawlIdescatLanguageIndex,
  refreshIdescatSearchIndex,
  renderLanguageIndexFiles,
} from "../../scripts/refresh-idescat.js";
import { getUtf8ByteLength } from "../../src/sources/common/caps.js";
import type { IdescatSearchIndexEntry } from "../../src/sources/idescat/search-index/types.js";

describe("crawlIdescatLanguageIndex", () => {
  it("crawls statistics, nodes, and tables into sorted search entries", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => jsonResponse(collectionFor(toUrl(input))));

    const index = await crawlIdescatLanguageIndex("ca", {
      fetchFn,
      generatedAt: "2026-04-26T00:00:00.000Z",
      indexVersion: "test",
      paceMs: 0,
    });

    expect(index).toMatchObject({
      lang: "ca",
      generatedAt: "2026-04-26T00:00:00.000Z",
      indexVersion: "test",
      sourceCollectionUrls: ["https://api.idescat.cat/taules/v2?lang=ca"],
    });
    expect(index.entries).toEqual([
      {
        statistics_id: "afi",
        node_id: "10",
        table_id: "99",
        label: "Affiliations table",
        ancestor_labels: {
          statistic: "Affiliations",
          node: "Affiliation node",
        },
        geo_ids: ["cat", "com"],
        source_url: "https://api.idescat.cat/taules/v2/afi/10/99?lang=ca",
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "477",
        label: "Population by sex",
        ancestor_labels: {
          statistic: "Municipal register",
          node: "Population by age",
        },
        geo_ids: ["cat"],
        source_url: "https://api.idescat.cat/taules/v2/pmh/1180/477?lang=ca",
      },
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        label: "Population by sex and age",
        ancestor_labels: {
          statistic: "Municipal register",
          node: "Population by age",
        },
        geo_ids: ["cat", "com", "mun"],
        source_url: "https://api.idescat.cat/taules/v2/pmh/1180/8078?lang=ca",
      },
    ]);
  });

  it("reuses cached geo collections across languages", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => jsonResponse(collectionFor(toUrl(input))));
    const geoIdsByTable = new Map<string, string[]>();

    await crawlIdescatLanguageIndex("ca", {
      fetchFn,
      generatedAt: "2026-04-26T00:00:00.000Z",
      geoIdsByTable,
      indexVersion: "test",
      paceMs: 0,
    });
    await crawlIdescatLanguageIndex("en", {
      fetchFn,
      generatedAt: "2026-04-26T00:00:00.000Z",
      geoIdsByTable,
      indexVersion: "test",
      paceMs: 0,
    });

    const geoFetches = fetchFn.mock.calls
      .map(([input]) => toUrl(input))
      .filter((url) => /^\/taules\/v2\/[^/]+\/[^/]+\/[^/]+$/u.test(url.pathname));

    expect(geoFetches.map((url) => url.pathname).sort()).toEqual([
      "/taules/v2/afi/10/99",
      "/taules/v2/pmh/1180/477",
      "/taules/v2/pmh/1180/8078",
    ]);
  });

  it("shares the geo cache through a full refresh", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => jsonResponse(collectionFor(toUrl(input))));

    await refreshIdescatSearchIndex({
      fetchFn,
      generatedAt: "2026-04-26T00:00:00.000Z",
      indexVersion: "test",
      languages: ["ca", "en"],
      outputDir: "/tmp/catalunya-opendata-mcp-refresh-test",
      paceMs: 0,
    });

    const geoFetches = fetchFn.mock.calls
      .map(([input]) => toUrl(input))
      .filter((url) => /^\/taules\/v2\/[^/]+\/[^/]+\/[^/]+$/u.test(url.pathname));

    expect(geoFetches).toHaveLength(3);
  });

  it("retries 429 with backoff", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, statusText: "Too Many" }))
      .mockResolvedValueOnce(jsonResponse(rootCollection([])));
    const sleep = vi.fn(async () => undefined);

    const index = await crawlIdescatLanguageIndex("ca", {
      fetchFn,
      sleep,
      paceMs: 0,
      maxRetries: 1,
      rng: () => 0,
    });

    expect(index.entries).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("retries 5xx with exponential backoff", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(new Response("boom", { status: 502, statusText: "Bad Gateway" }))
      .mockResolvedValueOnce(jsonResponse(rootCollection([])));
    const sleep = vi.fn(async () => undefined);

    const index = await crawlIdescatLanguageIndex("ca", {
      fetchFn,
      sleep,
      paceMs: 0,
      maxRetries: 2,
      rng: () => 0,
    });

    expect(index.entries).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it("retries network errors and recovers", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(rootCollection([])));
    const sleep = vi.fn(async () => undefined);

    const index = await crawlIdescatLanguageIndex("ca", {
      fetchFn,
      sleep,
      paceMs: 0,
      maxRetries: 2,
      rng: () => 0,
    });

    expect(index.entries).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("boom", { status: 500, statusText: "Server Error" }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      crawlIdescatLanguageIndex("ca", {
        fetchFn,
        sleep,
        paceMs: 0,
        maxRetries: 2,
        rng: () => 0,
      }),
    ).rejects.toThrow(/HTTP 500/u);

    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws on the original error after exhausting network retries", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      crawlIdescatLanguageIndex("ca", {
        fetchFn,
        sleep,
        paceMs: 0,
        maxRetries: 1,
        rng: () => 0,
      }),
    ).rejects.toThrow(/network down/u);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately on non-retryable HTTP errors", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      crawlIdescatLanguageIndex("ca", {
        fetchFn,
        sleep,
        paceMs: 0,
        maxRetries: 4,
        rng: () => 0,
      }),
    ).rejects.toThrow(/HTTP 404/u);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("renderLanguageIndexFiles", () => {
  it("renders a flat language module under the shard threshold", () => {
    const files = renderLanguageIndexFiles(languageIndex(entries()), 1_000_000);

    expect(files.map((file) => file.relativePath)).toEqual(["ca.ts"]);
    expect(files[0]?.content).toContain(
      'import type { IdescatSearchIndexEntry } from "./types.js";',
    );
    expect(files[0]?.content).toContain('export const indexVersion = "test";');
  });

  it("renders per-statistic shards when flat output exceeds the threshold", () => {
    const flatContent =
      renderLanguageIndexFiles(languageIndex(entries()), 1_000_000)[0]?.content ?? "";
    const pmhContent =
      renderLanguageIndexFiles(
        languageIndex(entries().filter((entry) => entry.statistics_id === "pmh")),
        1_000_000,
      )[0]?.content ?? "";
    const aturContent =
      renderLanguageIndexFiles(
        languageIndex(entries().filter((entry) => entry.statistics_id === "atur")),
        1_000_000,
      )[0]?.content ?? "";
    const threshold = Math.max(getUtf8ByteLength(pmhContent), getUtf8ByteLength(aturContent)) + 1;

    expect(threshold).toBeLessThan(getUtf8ByteLength(flatContent));

    const files = renderLanguageIndexFiles(languageIndex(entries()), threshold);

    expect(files.map((file) => file.relativePath)).toEqual([
      "ca.ts",
      "ca/atur.ts",
      "ca/index.ts",
      "ca/pmh.ts",
    ]);
    expect(files.find((file) => file.relativePath === "ca.ts")?.content).toContain(
      'from "./ca/index.js"',
    );
  });

  it("renders empty language modules", () => {
    const files = renderLanguageIndexFiles(languageIndex([]), 1_000_000);

    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain("const entries: IdescatSearchIndexEntry[] = [];");
  });
});

function collectionFor(url: URL) {
  if (url.pathname === "/taules/v2") {
    return rootCollection([
      { href: "pmh", label: "Municipal register" },
      { href: "https://api.idescat.cat/taules/v2/afi", label: "Affiliations" },
    ]);
  }

  if (url.pathname === "/taules/v2/pmh") {
    return {
      class: "collection",
      label: "Municipal register",
      href: "https://api.idescat.cat/taules/v2/pmh",
      link: {
        item: [{ href: "1180", label: "Population by age" }],
      },
    };
  }

  if (url.pathname === "/taules/v2/pmh/1180") {
    return {
      class: "collection",
      label: "Population by age",
      href: "https://api.idescat.cat/taules/v2/pmh/1180",
      link: {
        item: [
          { href: "8078", label: "Population by sex and age" },
          {
            href: "https://api.idescat.cat/taules/v2/pmh/1180/477",
            label: "Population by sex",
          },
        ],
      },
    };
  }

  if (url.pathname === "/taules/v2/pmh/1180/8078") {
    return {
      class: "collection",
      label: "Population by sex and age",
      href: "https://api.idescat.cat/taules/v2/pmh/1180/8078",
      link: {
        item: [
          { href: "mun", label: "By municipalities" },
          { href: "cat", label: "Catalonia" },
          { href: "com", label: "By counties" },
        ],
      },
    };
  }

  if (url.pathname === "/taules/v2/pmh/1180/477") {
    return {
      class: "collection",
      label: "Population by sex",
      href: "https://api.idescat.cat/taules/v2/pmh/1180/477",
      link: {
        item: [{ href: "cat", label: "Catalonia" }],
      },
    };
  }

  if (url.pathname === "/taules/v2/afi") {
    return {
      class: "collection",
      label: "Affiliations",
      href: "https://api.idescat.cat/taules/v2/afi",
      link: {
        item: [{ href: "10", label: "Affiliation node" }],
      },
    };
  }

  if (url.pathname === "/taules/v2/afi/10") {
    return {
      class: "collection",
      label: "Affiliation node",
      href: "https://api.idescat.cat/taules/v2/afi/10",
      link: {
        item: [{ href: "99", label: "Affiliations table" }],
      },
    };
  }

  if (url.pathname === "/taules/v2/afi/10/99") {
    return {
      class: "collection",
      label: "Affiliations table",
      href: "https://api.idescat.cat/taules/v2/afi/10/99",
      link: {
        item: [
          { href: "com", label: "By counties" },
          { href: "cat", label: "Catalonia" },
        ],
      },
    };
  }

  throw new Error(`Unexpected URL ${url.toString()}`);
}

function rootCollection(items: Array<{ href: string; label: string }>) {
  return {
    class: "collection",
    label: "Root",
    href: "https://api.idescat.cat/taules/v2",
    link: {
      item: items,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input.toString());
}

function languageIndex(entries: IdescatSearchIndexEntry[]) {
  return {
    lang: "ca" as const,
    generatedAt: "2026-04-26T00:00:00.000Z",
    indexVersion: "test",
    sourceCollectionUrls: ["https://api.idescat.cat/taules/v2?lang=ca"],
    entries,
  };
}

function entries(): IdescatSearchIndexEntry[] {
  return [
    {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      label: "Population by sex and age",
      ancestor_labels: {
        statistic: "Municipal register",
        node: "Population by age",
      },
      geo_ids: ["cat", "com", "mun"],
      source_url: "https://api.idescat.cat/taules/v2/pmh/1180/8078?lang=ca",
    },
    {
      statistics_id: "atur",
      node_id: "1",
      table_id: "2",
      label: "Registered unemployment",
      ancestor_labels: {
        statistic: "Labour market",
        node: "Unemployment",
      },
      geo_ids: ["cat"],
      source_url: "https://api.idescat.cat/taules/v2/atur/1/2?lang=ca",
    },
  ];
}
