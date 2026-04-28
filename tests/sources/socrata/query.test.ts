import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import { getJsonToolResultByteLength } from "../../../src/sources/common/caps.js";
import { SOCRATA_CATALOG_DOMAIN, SOCRATA_USER_AGENT } from "../../../src/sources/socrata/client.js";
import {
  createSocrataQueryProvenance,
  querySocrataDataset,
  SOCRATA_QUERY_CLAUSE_MAX_BYTES,
  SOCRATA_QUERY_URL_MAX_BYTES,
} from "../../../src/sources/socrata/query.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  socrataAppToken: undefined,
};

describe("querySocrataDataset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a SODA resource request with raw clauses, sentinel limit, and headers", async () => {
    const fetchMock = mockRowsResponse([]);

    const result = await querySocrataDataset(
      {
        source_id: "v8i4-fa4q",
        select: "municipi, comarca",
        where: "comarca = 'Gironès'",
        group: "municipi, comarca",
        order: "municipi",
        limit: 2,
        offset: 5,
      },
      {
        ...baseConfig,
        socrataAppToken: "token",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(requestUrl.toString());
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://${SOCRATA_CATALOG_DOMAIN}/resource/v8i4-fa4q.json`,
    );
    expect(url.searchParams.get("$select")).toBe("municipi, comarca");
    expect(url.searchParams.get("$where")).toBe("comarca = 'Gironès'");
    expect(url.searchParams.get("$group")).toBe("municipi, comarca");
    expect(url.searchParams.get("$order")).toBe("municipi");
    expect(url.searchParams.get("$limit")).toBe("3");
    expect(url.searchParams.get("$offset")).toBe("5");
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": SOCRATA_USER_AGENT,
      "X-App-Token": "token",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.data).toMatchObject({
      source_id: "v8i4-fa4q",
      source_domain: SOCRATA_CATALOG_DOMAIN,
      select: "municipi, comarca",
      where: "comarca = 'Gironès'",
      group: "municipi, comarca",
      order: "municipi",
      limit: 2,
      offset: 5,
      row_count: 0,
      truncated: false,
      rows: [],
    });
    expect(new URL(result.data.request_url).searchParams.get("$limit")).toBe("3");
    expect(new URL(result.data.logical_request_url).searchParams.get("$limit")).toBe("2");
    expect(result.provenance.source_url).toBe(result.data.request_url);
  });

  it("trims and omits empty optional clauses", async () => {
    mockRowsResponse([{ municipi: "Girona" }]);

    const result = await querySocrataDataset(
      {
        source_id: " v8i4-fa4q ",
        select: " municipi ",
        where: " ",
        group: "",
        order: undefined,
        limit: 1,
      },
      baseConfig,
    );

    expect(result.data.select).toBe("municipi");
    expect("where" in result.data).toBe(false);
    expect("group" in result.data).toBe(false);
    expect("order" in result.data).toBe(false);
  });

  it("uses the sentinel row to distinguish exact-page results from truncation", async () => {
    mockRowsResponse([{ id: "1" }, { id: "2" }]);

    const exactPage = await querySocrataDataset(
      {
        source_id: "v8i4-fa4q",
        limit: 2,
      },
      baseConfig,
    );

    expect(exactPage.data).toMatchObject({
      row_count: 2,
      truncated: false,
      rows: [{ id: "1" }, { id: "2" }],
    });

    vi.restoreAllMocks();
    mockRowsResponse([{ id: "1" }, { id: "2" }, { id: "3" }]);

    const overPage = await querySocrataDataset(
      {
        source_id: "v8i4-fa4q",
        limit: 2,
      },
      baseConfig,
    );

    expect(overPage.data).toMatchObject({
      row_count: 2,
      truncated: true,
      truncation_reason: "row_cap",
      rows: [{ id: "1" }, { id: "2" }],
    });
  });

  it("drops rows from the tail when the success envelope exceeds the byte cap", async () => {
    mockRowsResponse([
      { id: "1", notes: "x".repeat(1_000) },
      { id: "2", notes: "x".repeat(1_000) },
      { id: "3", notes: "x".repeat(1_000) },
      { id: "4", notes: "x".repeat(1_000) },
    ]);

    const result = await querySocrataDataset(
      {
        source_id: "v8i4-fa4q",
        limit: 3,
      },
      {
        ...baseConfig,
        responseMaxBytes: 1_800,
      },
    );

    expect(result.data.truncated).toBe(true);
    expect(result.data.truncation_reason).toBe("byte_cap");
    expect(result.data.truncation_hint).toBe("narrow filters or reduce $select");
    expect(result.data.row_count).toBe(result.data.rows.length);
    expect(getJsonToolResultByteLength(result)).toBeLessThanOrEqual(1_800);
  });

  it("prefers byte_cap over row_cap when both truncations apply", async () => {
    // limit=2 + sentinel asks for 3 rows; upstream returns 4 rows.
    // The sentinel triggers row_cap, then the byte cap pops further rows.
    // Plan requires the more actionable signal (byte_cap) to win.
    mockRowsResponse([
      { id: "1", notes: "x".repeat(1_000) },
      { id: "2", notes: "x".repeat(1_000) },
      { id: "3", notes: "x".repeat(1_000) },
      { id: "4", notes: "x".repeat(1_000) },
    ]);

    const result = await querySocrataDataset(
      {
        source_id: "v8i4-fa4q",
        limit: 2,
      },
      {
        ...baseConfig,
        responseMaxBytes: 1_800,
      },
    );

    expect(result.data.truncated).toBe(true);
    expect(result.data.truncation_reason).toBe("byte_cap");
    expect(result.data.rows.length).toBeLessThan(2);
  });

  it("emits row_cap with the row-cap hint when only the sentinel triggers", async () => {
    mockRowsResponse([{ id: "1" }, { id: "2" }, { id: "3" }]);

    const result = await querySocrataDataset({ source_id: "v8i4-fa4q", limit: 2 }, baseConfig);

    expect(result.data.truncation_reason).toBe("row_cap");
    expect(result.data.truncation_hint).toBe(
      "raise limit (within maxResults) or paginate with $offset",
    );
  });

  it("throws invalid_response when the empty-rows envelope already exceeds the cap", async () => {
    mockRowsResponse([]);

    await expect(
      querySocrataDataset({ source_id: "v8i4-fa4q" }, { ...baseConfig, responseMaxBytes: 100 }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining("response cap"),
    });
  });

  it("rejects when combined clauses push the URL over the byte cap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));
    // Each clause is well under the per-clause cap, but together they exceed the URL cap.
    const halfClause = "x".repeat(SOCRATA_QUERY_CLAUSE_MAX_BYTES - 8);

    await expect(
      querySocrataDataset(
        {
          source_id: "v8i4-fa4q",
          select: halfClause,
          where: halfClause,
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining(`${SOCRATA_QUERY_URL_MAX_BYTES}-byte`),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid input before fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));
    const oversizedClause = "x".repeat(SOCRATA_QUERY_CLAUSE_MAX_BYTES + 1);

    for (const input of [
      { source_id: "abc" },
      { source_id: "V8I4-FA4Q" },
      { source_id: "v8i4-fa4q", limit: 0 },
      { source_id: "v8i4-fa4q", limit: 101 },
      { source_id: "v8i4-fa4q", limit: 1.5 },
      { source_id: "v8i4-fa4q", limit: 1e21 },
      { source_id: "v8i4-fa4q", offset: -1 },
      { source_id: "v8i4-fa4q", offset: 1e21 },
      { source_id: "v8i4-fa4q", where: oversizedClause },
    ]) {
      await expect(querySocrataDataset(input, baseConfig)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to domain-root provenance for unsafe query inputs", () => {
    expect(createSocrataQueryProvenance({ source_id: "abc" }, baseConfig)).toMatchObject({
      source_url: `https://${SOCRATA_CATALOG_DOMAIN}/`,
      id: `${SOCRATA_CATALOG_DOMAIN}:dataset_query`,
    });
  });

  it("rejects non-array responses and non-object rows", async () => {
    mockRowsResponse({ error: "not rows" });

    await expect(querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig)).rejects.toMatchObject(
      {
        code: "invalid_response",
      },
    );

    vi.restoreAllMocks();
    mockRowsResponse([{ id: "1" }, null]);

    await expect(querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig)).rejects.toMatchObject(
      {
        code: "invalid_response",
      },
    );
  });

  it("passes nested JSON row values through unchanged", async () => {
    const rows = [
      {
        active: true,
        amount: 1.25,
        tags: ["a", "b"],
        location: { latitude: "41.98", longitude: "2.82" },
        empty: null,
      },
    ];
    mockRowsResponse(rows);

    const result = await querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig);

    expect(result.data.rows).toEqual(rows);
  });

  it("converts HTTP, network, and timeout failures into typed Socrata errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "bad where" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig)).rejects.toMatchObject(
      {
        code: "http_error",
        retryable: false,
        status: 400,
        message: expect.stringContaining("bad where"),
      },
    );

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket closed"));

    await expect(querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig)).rejects.toMatchObject(
      {
        code: "network_error",
        retryable: true,
      },
    );

    vi.restoreAllMocks();
    const timeoutError = new Error("deadline exceeded");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);

    await expect(querySocrataDataset({ source_id: "v8i4-fa4q" }, baseConfig)).rejects.toMatchObject(
      {
        code: "timeout",
        retryable: true,
      },
    );
  });
});

function mockRowsResponse(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
}
