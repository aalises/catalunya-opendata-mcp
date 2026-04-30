import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchBcnAreaGeometry,
  isPointInBcnWgs84Geometry,
  parseBcnWgs84Geometry,
} from "../../../src/sources/bcn/area.js";
import { baseConfig, ckanSuccess, mockFetchResponses } from "./helpers.js";

describe("BCN area helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses polygon WKT into bbox, center, and rings", () => {
    const geometry = parseBcnWgs84Geometry(
      "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))",
    );

    expect(geometry).toMatchObject({
      geometry_type: "polygon",
      bbox: {
        min_lat: 41.4,
        min_lon: 2.1,
        max_lat: 41.5,
        max_lon: 2.2,
      },
      center: {
        lat: 41.45,
        lon: 2.1500000000000004,
      },
    });
    expect(geometry.rings).toHaveLength(1);
  });

  it("handles multipolygons and point containment", () => {
    const geometry = parseBcnWgs84Geometry(
      "MULTIPOLYGON (((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40)), ((2.30 41.60, 2.40 41.60, 2.40 41.70, 2.30 41.70, 2.30 41.60)))",
    );

    expect(geometry.geometry_type).toBe("multipolygon");
    expect(isPointInBcnWgs84Geometry({ lat: 41.45, lon: 2.15 }, geometry)).toBe(true);
    expect(isPointInBcnWgs84Geometry({ lat: 41.65, lon: 2.35 }, geometry)).toBe(true);
    expect(isPointInBcnWgs84Geometry({ lat: 41.55, lon: 2.25 }, geometry)).toBe(false);
  });

  it("keeps polygon holes scoped to their polygon parts", () => {
    const geometry = parseBcnWgs84Geometry(
      "MULTIPOLYGON (((2.00 41.00, 2.30 41.00, 2.30 41.30, 2.00 41.30, 2.00 41.00), (2.10 41.10, 2.20 41.10, 2.20 41.20, 2.10 41.20, 2.10 41.10)), ((2.40 41.40, 2.50 41.40, 2.50 41.50, 2.40 41.50, 2.40 41.40)))",
    );

    expect(geometry.polygons).toHaveLength(2);
    expect(isPointInBcnWgs84Geometry({ lat: 41.05, lon: 2.05 }, geometry)).toBe(true);
    expect(isPointInBcnWgs84Geometry({ lat: 41.15, lon: 2.15 }, geometry)).toBe(false);
    expect(isPointInBcnWgs84Geometry({ lat: 41.45, lon: 2.45 }, geometry)).toBe(true);
  });

  it("fetches one area geometry row from BCN DataStore", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess({
        records: [
          {
            _id: 7,
            geometria_wgs84:
              "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))",
          },
        ],
      }),
    );

    const result = await fetchBcnAreaGeometry(
      {
        source_resource_id: "district-resource",
        row_id: "7",
      },
      baseConfig,
    );

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://opendata-ajuntament.barcelona.cat/data/api/action/datastore_search",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      resource_id: "district-resource",
      filters: {
        _id: 7,
      },
      fields: ["_id", "geometria_wgs84"],
      limit: 1,
    });
    expect(result.areaFilter).toMatchObject({
      mode: "polygon",
      source_resource_id: "district-resource",
      row_id: 7,
      geometry_field: "geometria_wgs84",
      geometry_type: "polygon",
    });
    expect(result.geometry.bbox).toEqual(result.areaFilter.bbox);
  });

  it("rejects missing area rows", async () => {
    mockFetchResponses(ckanSuccess({ records: [] }));

    await expect(
      fetchBcnAreaGeometry(
        {
          source_resource_id: "district-resource",
          row_id: 999,
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("did not match"),
    });
  });
});
