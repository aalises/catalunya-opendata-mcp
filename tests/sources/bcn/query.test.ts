import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BCN_QUERY_FILTER_TOTAL_MAX_BYTES,
  queryBcnResource,
} from "../../../src/sources/bcn/query.js";
import { getJsonToolResultByteLength } from "../../../src/sources/common/caps.js";
import {
  baseConfig,
  bcnResource,
  ckanFailure,
  ckanSuccess,
  mockFetchResponses,
} from "./helpers.js";

describe("queryBcnResource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs structured DataStore requests without prefetching resource metadata on success", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess({
        fields: [
          { id: "_id", type: "int" },
          { id: "Nom", type: "text" },
        ],
        records: [{ _id: 1, Nom: "A" }],
        total: 1,
      }),
    );

    const result = await queryBcnResource(
      {
        resource_id: " resource-1 ",
        filters: { Districte: "Eixample", nested: { ok: true } },
        q: " escola ",
        fields: [" _id ", "Nom"],
        sort: "Nom asc",
        limit: 2,
        offset: 5,
      },
      baseConfig,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe(
      "https://opendata-ajuntament.barcelona.cat/data/api/action/datastore_search",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      resource_id: "resource-1",
      limit: 3,
      offset: 5,
      filters: { Districte: "Eixample", nested: { ok: true } },
      q: "escola",
      fields: ["_id", "Nom"],
      sort: "Nom asc",
    });
    expect(result.data).toMatchObject({
      resource_id: "resource-1",
      request_method: "POST",
      request_body: {
        resource_id: "resource-1",
        limit: 2,
        offset: 5,
      },
      row_count: 1,
      total: 1,
      truncated: false,
      rows: [{ _id: 1, Nom: "A" }],
    });
  });

  it("maps inactive DataStore resources to invalid_input after datastore failure", async () => {
    const fetchMock = mockFetchResponses(
      ckanFailure({ message: "Not found: resource is not in datastore" }),
      ckanSuccess(bcnResource({ datastore_active: false, package_id: null })),
    );

    await expect(queryBcnResource({ resource_id: "resource-1" }, baseConfig)).rejects.toMatchObject(
      {
        code: "invalid_input",
        message: expect.stringContaining("not DataStore-active"),
        source_error: {
          message: "Not found: resource is not in datastore",
        },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses sentinel rows for truncation but keeps logical request_body replayable", async () => {
    mockFetchResponses(
      ckanSuccess({
        fields: [{ id: "id", type: "text" }],
        records: [{ id: "1" }, { id: "2" }, { id: "3" }],
        total: 3,
      }),
    );

    const result = await queryBcnResource({ resource_id: "resource-1", limit: 2 }, baseConfig);

    expect(result.data).toMatchObject({
      row_count: 2,
      truncated: true,
      truncation_reason: "row_cap",
      request_body: {
        resource_id: "resource-1",
        limit: 2,
        offset: 0,
      },
      rows: [{ id: "1" }, { id: "2" }],
    });
  });

  it("drops rows when the response envelope exceeds responseMaxBytes", async () => {
    mockFetchResponses(
      ckanSuccess({
        fields: [{ id: "id", type: "text" }],
        records: [
          { id: "1", notes: "x".repeat(1_000) },
          { id: "2", notes: "x".repeat(1_000) },
          { id: "3", notes: "x".repeat(1_000) },
        ],
        total: 3,
      }),
    );

    const result = await queryBcnResource(
      { resource_id: "resource-1", limit: 3 },
      { ...baseConfig, responseMaxBytes: 1_500 },
    );

    expect(result.data.truncated).toBe(true);
    expect(result.data.truncation_reason).toBe("byte_cap");
    expect(result.data.row_count).toBe(result.data.rows.length);
    expect(getJsonToolResultByteLength(result)).toBeLessThanOrEqual(1_500);
  });

  it("rejects oversized structured filters before fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));

    await expect(
      queryBcnResource(
        {
          resource_id: "resource-1",
          filters: { ids: "x".repeat(BCN_QUERY_FILTER_TOTAL_MAX_BYTES + 1) },
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      source_error: {
        rule: "filter_total_bytes",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
