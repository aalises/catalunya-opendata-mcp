import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { searchSocrataDatasets } from "../../src/sources/socrata/catalog.js";
import { describeSocrataDataset } from "../../src/sources/socrata/dataset.js";
import { querySocrataDataset } from "../../src/sources/socrata/query.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  socrataAppToken: undefined,
};

describe("Socrata recorded fixtures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates the recorded search, describe, and query fixtures through adapters", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(loadFixture("catalog-search-habitatges.json")))
      .mockResolvedValueOnce(jsonResponse(loadFixture("view-j8h8-vxug.json")))
      .mockResolvedValueOnce(jsonResponse(loadFixture("query-j8h8-vxug.json")));

    const search = await searchSocrataDatasets(
      {
        query: "Habitatges iniciats acabats",
        limit: 10,
        offset: 0,
      },
      testConfig,
    );
    expect(search.data.results[0]).toMatchObject({
      source_id: "j8h8-vxug",
      source_domain: "analisi.transparenciacatalunya.cat",
      title: "Habitatges iniciats i acabats. Sèrie històrica trimestral 2000 – actualitat",
    });

    const describe = await describeSocrataDataset({ source_id: "j8h8-vxug" }, testConfig);
    expect(describe.data).toMatchObject({
      source_id: "j8h8-vxug",
      rows_updated_at: "2025-11-10T09:43:54.000Z",
      provenance: {
        source: "socrata",
        id: "j8h8-vxug",
      },
    });
    expect(describe.data.columns.map((column) => column.field_name)).toEqual([
      "codi_idescat",
      "codi_ine",
      "municipi",
      "codi_comarca_2023",
      "comarca_2023",
      "any",
    ]);

    const query = await querySocrataDataset(
      {
        source_id: "j8h8-vxug",
        select: "codi_idescat, codi_ine, municipi",
        order: "municipi",
        limit: 2,
      },
      testConfig,
    );
    expect(query.data).toMatchObject({
      source_id: "j8h8-vxug",
      row_count: 2,
      truncated: false,
    });
    expect(query.data.rows[0]).toEqual({
      codi_idescat: "250019",
      codi_ine: "25001",
      municipi: "Abella de la Conca",
    });
  });
});

function loadFixture(name: string): unknown {
  const text = readFileSync(new URL(`../fixtures/socrata/${name}`, import.meta.url), "utf8");

  return JSON.parse(text);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
