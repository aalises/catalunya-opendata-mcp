import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import { getUrlByteLength } from "../../../src/sources/common/caps.js";
import { IDESCAT_USER_AGENT } from "../../../src/sources/idescat/client.js";
import { getIdescatTableData } from "../../../src/sources/idescat/data.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  socrataAppToken: undefined,
};

describe("getIdescatTableData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a filtered Tables v2 request and flattens JSON-stat rows", async () => {
    const fetchMock = mockJsonResponse(jsonStatDataset());

    const result = await getIdescatTableData(
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "en",
        filters: {
          SEX: "F",
          COM: ["01", "TOTAL"],
        },
        last: 2,
        limit: 3,
      },
      baseConfig,
    );

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/taules/v2/pmh/1180/8078/com/data");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("COM")).toBe("01,TOTAL");
    expect(url.searchParams.get("SEX")).toBe("F");
    expect(url.searchParams.get("_LAST_")).toBe("2");
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": IDESCAT_USER_AGENT,
    });

    expect(result.data).toMatchObject({
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "com",
      lang: "en",
      limit: 3,
      row_count: 3,
      selected_cell_count: 4,
      truncated: true,
      truncation_reason: "row_cap",
    });
    expect(result.data.rows[0]).toEqual({
      value: 10,
      dimensions: {
        YEAR: { id: "2021", label: "2021" },
        COM: { id: "01", label: "Alt Camp" },
        SEX: { id: "F", label: "females" },
        VALUE: { id: "POP", label: "population" },
      },
    });
    expect(result.data.rows[2]?.status).toEqual({
      code: "p",
      label: "Provisional data",
    });
    expect(result.data.units?.by_dimension?.VALUE?.POP).toEqual({ decimals: 0 });
  });

  it("keeps long multi-value filters in the GET query instead of falling back to POST", async () => {
    const fetchMock = mockJsonResponse(jsonStatDataset());
    const comFilter = Array(9).fill("x".repeat(240));

    const result = await getIdescatTableData(
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "en",
        filters: {
          COM: comFilter,
          SEX: "F",
        },
        last: 2,
        limit: 3,
      },
      baseConfig,
    );

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(requestUrl);

    expect(getUrlByteLength(url)).toBeGreaterThan(2_000);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(url.pathname).toBe("/taules/v2/pmh/1180/8078/com/data");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("COM")).toBe(comFilter.join(","));
    expect(url.searchParams.get("SEX")).toBe("F");
    expect(url.searchParams.get("_LAST_")).toBe("2");

    expect(result.data.request_method).toBe("GET");
    expect(result.data.request_url).toBe(result.data.logical_request_url);
    expect(result.data).not.toHaveProperty("request_body_params");
  });

  it("maps IDESCAT cell-limit errors to narrow_filters with source_error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "2.0",
          class: "error",
          status: "416",
          id: "05",
          label: "Data limit exceeded.",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 416,
        },
      ),
    );

    await expect(
      getIdescatTableData(
        {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "narrow_filters",
      status: 416,
      source_error: {
        id: "05",
      },
    });
  });

  it("rejects sparse JSON-stat value indexes outside the declared dimensions", async () => {
    const body = jsonStatDataset();
    body.value = {
      4: 50,
    } as unknown as number[];
    mockJsonResponse(body);

    await expect(
      getIdescatTableData(
        {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "IDESCAT data value index is outside dimension bounds.",
    });
  });
});

function mockJsonResponse(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
}

function jsonStatDataset() {
  return {
    version: "2.0",
    class: "dataset",
    href: "https://api.idescat.cat/taules/v2/pmh/1180/8078/com/data?lang=en",
    label: "Population by county",
    updated: "2026-01-01",
    id: ["YEAR", "COM", "SEX", "VALUE"],
    size: [2, 2, 1, 1],
    role: {
      time: ["YEAR"],
      geo: ["COM"],
      metric: ["VALUE"],
    },
    dimension: {
      YEAR: {
        label: "year",
        category: {
          index: ["2021", "2022"],
          label: {
            "2021": "2021",
            "2022": "2022",
          },
        },
        extension: {
          status: {
            "2022": "p",
          },
        },
      },
      COM: {
        label: "county",
        category: {
          index: ["01", "TOTAL"],
          label: {
            "01": "Alt Camp",
            TOTAL: "Catalonia",
          },
        },
      },
      SEX: {
        label: "sex",
        category: {
          index: ["F"],
          label: {
            F: "females",
          },
        },
      },
      VALUE: {
        label: "value",
        category: {
          index: ["POP"],
          label: {
            POP: "population",
          },
          unit: {
            POP: {
              decimals: 0,
            },
          },
        },
      },
    },
    value: [10, 20, 30, 40],
    extension: {
      status: {
        label: {
          p: "Provisional data",
        },
      },
      source: ["Idescat."],
    },
  };
}
