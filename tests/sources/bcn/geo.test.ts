import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBcnDistanceMeters,
  inferBcnCoordinateFields,
  normalizeBcnGeoText,
  queryBcnResourceGeo,
} from "../../../src/sources/bcn/geo.js";
import { baseConfig, bcnResource, ckanSuccess, mockFetchResponses } from "./helpers.js";

describe("BCN geo helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("infers common WGS84 coordinate field pairs and reports ambiguity", () => {
    expect(inferBcnCoordinateFields(["name", "latitud", "longitud"]).coordinate_fields).toEqual({
      lat: "latitud",
      lon: "longitud",
    });
    expect(inferBcnCoordinateFields(["LATITUD", "LONGITUD"]).coordinate_fields).toEqual({
      lat: "LATITUD",
      lon: "LONGITUD",
    });
    expect(
      inferBcnCoordinateFields(["geo_epgs_4326_lat", "geo_epgs_4326_lon"]).coordinate_fields,
    ).toEqual({
      lat: "geo_epgs_4326_lat",
      lon: "geo_epgs_4326_lon",
    });
    expect(() =>
      inferBcnCoordinateFields(["latitud", "longitud", "geo_epgs_4326_lat", "geo_epgs_4326_lon"]),
    ).toThrow(/Multiple possible/);
    expect(() => inferBcnCoordinateFields(["name", "x_etrs89", "y_etrs89"])).toThrow(/No WGS84/);
  });

  it("normalizes Catalan street text for contains filters and computes distances", () => {
    expect(normalizeBcnGeoText("C\\ Consell de Cent, 623")).toBe("consell de cent 623");
    expect(normalizeBcnGeoText("Carrer Consell de Cent")).toBe("consell de cent");
    expect(
      getBcnDistanceMeters({ lat: 41.4036, lon: 2.1744 }, { lat: 41.4037, lon: 2.1745 }),
    ).toBeLessThan(20);
  });

  it("queries DataStore-active resources by near, contains, selected fields, and grouping", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          datastore_active: true,
          format: "CSV",
        }),
      ),
      ckanSuccess({
        fields: [
          { id: "_id", type: "int" },
          { id: "name", type: "text" },
          { id: "addresses_road_name", type: "text" },
          { id: "secondary_filters_name", type: "text" },
          { id: "geo_epgs_4326_lat", type: "numeric" },
          { id: "geo_epgs_4326_lon", type: "numeric" },
        ],
      }),
      ckanSuccess({
        records: [
          {
            _id: 1,
            name: "Library A",
            addresses_road_name: "Carrer Mallorca",
            secondary_filters_name: "Library",
            geo_epgs_4326_lat: 41.4036,
            geo_epgs_4326_lon: 2.1744,
          },
          {
            _id: 2,
            name: "Library B",
            addresses_road_name: "Carrer Mallorca",
            secondary_filters_name: "Library",
            geo_epgs_4326_lat: 41.404,
            geo_epgs_4326_lon: 2.175,
          },
          {
            _id: 3,
            name: "Far",
            addresses_road_name: "Carrer Mallorca",
            secondary_filters_name: "School",
            geo_epgs_4326_lat: 41.45,
            geo_epgs_4326_lon: 2.2,
          },
        ],
        total: 3,
      }),
    );

    const result = await queryBcnResourceGeo(
      {
        resource_id: "resource-1",
        near: { lat: 41.4036, lon: 2.1744, radius_m: 100 },
        contains: { addresses_road_name: "Carrer Mallorca" },
        fields: ["_id", "name"],
        group_by: "secondary_filters_name",
        limit: 1,
      },
      baseConfig,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, fieldInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(JSON.parse(String(fieldInit.body))).toEqual({
      resource_id: "resource-1",
      limit: 0,
    });
    const [, pageInit] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(JSON.parse(String(pageInit.body))).toEqual({
      resource_id: "resource-1",
      limit: 1000,
      offset: 0,
      fields: [
        "_id",
        "name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
        "secondary_filters_name",
        "addresses_road_name",
      ],
    });
    expect(result.data).toMatchObject({
      strategy: "datastore",
      coordinate_fields: {
        lat: "geo_epgs_4326_lat",
        lon: "geo_epgs_4326_lon",
      },
      row_count: 1,
      matched_row_count: 2,
      truncated: true,
      truncation_reason: "row_cap",
      rows: [
        {
          _id: 1,
          name: "Library A",
          _geo: {
            lat: 41.4036,
            lon: 2.1744,
            distance_m: 0,
          },
        },
      ],
      groups: [
        {
          key: "Library",
          count: 2,
        },
      ],
      upstream_total: 3,
      logical_request_body: {
        resource_id: "resource-1",
        limit: 1,
        offset: 0,
      },
    });
  });

  it("filters DataStore-active resources by bbox", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          datastore_active: true,
        }),
      ),
      ckanSuccess({
        fields: [
          { id: "name", type: "text" },
          { id: "latitud", type: "numeric" },
          { id: "longitud", type: "numeric" },
        ],
      }),
      ckanSuccess({
        records: [
          { name: "Inside", latitud: 41.4, longitud: 2.17 },
          { name: "Outside", latitud: 41.6, longitud: 2.4 },
        ],
        total: 2,
      }),
    );

    const result = await queryBcnResourceGeo(
      {
        resource_id: "resource-1",
        bbox: { min_lat: 41.3, min_lon: 2.1, max_lat: 41.5, max_lon: 2.2 },
        fields: ["name"],
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      strategy: "datastore",
      row_count: 1,
      matched_row_count: 1,
      upstream_total: 2,
      rows: [
        {
          name: "Inside",
          _geo: {
            lat: 41.4,
            lon: 2.17,
          },
        },
      ],
    });
    expect(result.data.rows[0]?._geo).not.toHaveProperty("distance_m");
  });

  it("scans safe CSV downloads with text filters and group counts", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          datastore_active: false,
          url: "https://opendata-ajuntament.barcelona.cat/download/trees.csv",
        }),
      ),
      new Response(
        [
          "adreca;latitud;longitud;cat_nom_catala",
          "C\\ Consell de Cent, 1;41.39;2.16;Lledoner",
          "Carrer Mallorca, 2;41.40;2.17;Platan",
          "C\\ Consell de Cent, 3;41.41;2.18;Lledoner",
        ].join("\n"),
        {
          headers: { "Content-Type": "text/csv; charset=utf-8" },
          status: 200,
        },
      ),
    );

    const result = await queryBcnResourceGeo(
      {
        resource_id: "resource-1",
        contains: { adreca: "Carrer Consell de Cent" },
        group_by: "cat_nom_catala",
        fields: ["adreca", "cat_nom_catala"],
        limit: 10,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      strategy: "download_stream",
      coordinate_fields: {
        lat: "latitud",
        lon: "longitud",
      },
      scanned_row_count: 3,
      matched_row_count: 2,
      row_count: 2,
      truncated: false,
      groups: [
        {
          key: "Lledoner",
          count: 2,
        },
      ],
    });
    expect(result.data.rows[0]).toMatchObject({
      adreca: "C\\ Consell de Cent, 1",
      cat_nom_catala: "Lledoner",
      _geo: {
        lat: 41.39,
        lon: 2.16,
      },
    });
  });

  it("rejects unsafe download URLs and unsafe redirect hops through the geo path", async () => {
    const unsafeFetch = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://evil.example/trees.csv",
        }),
      ),
    );

    await expect(
      queryBcnResourceGeo(
        {
          resource_id: "resource-1",
          contains: { adreca: "Consell" },
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("opendata-ajuntament.barcelona.cat"),
    });
    expect(unsafeFetch).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    const redirectFetch = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://opendata-ajuntament.barcelona.cat/download/trees.csv",
        }),
      ),
      new Response(null, {
        headers: { Location: "https://evil.example/trees.csv" },
        status: 302,
      }),
    );

    await expect(
      queryBcnResourceGeo(
        {
          resource_id: "resource-1",
          contains: { adreca: "Consell" },
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(redirectFetch).toHaveBeenCalledTimes(2);
  });

  it("handles CSV charset fallback and byte-cap row trimming on the geo path", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://opendata-ajuntament.barcelona.cat/download/trees.csv",
        }),
      ),
      new Response(Buffer.from("name;latitud;longitud\ncaf\xe9;41.1;2.1\nB;41.2;2.2\n", "latin1"), {
        headers: { "Content-Type": "text/csv" },
        status: 200,
      }),
    );

    const result = await queryBcnResourceGeo(
      {
        resource_id: "resource-1",
        bbox: { min_lat: 41, min_lon: 2, max_lat: 42, max_lon: 3 },
        fields: ["name"],
        limit: 10,
      },
      { ...baseConfig, bcnGeoScanBytes: 37 },
    );

    expect(result.data).toMatchObject({
      strategy: "download_stream",
      row_count: 1,
      truncated: true,
      truncation_reason: "byte_cap",
      rows: [
        {
          name: "café",
          _geo: {
            lat: 41.1,
            lon: 2.1,
          },
        },
      ],
    });
  });

  it("rejects invalid shapes before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));

    await expect(
      queryBcnResourceGeo({ resource_id: "resource-1" }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("requires at least one narrowing"),
    });
    await expect(
      queryBcnResourceGeo(
        {
          resource_id: "resource-1",
          near: { lat: 41.4, lon: 2.17, radius_m: 6_000 },
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("radius_m"),
    });
    await expect(
      queryBcnResourceGeo(
        {
          resource_id: "resource-1",
          near: { lat: 41.4, lon: 2.17 },
          bbox: { min_lat: 41.3, min_lon: 2.1, max_lat: 41.5, max_lon: 2.2 },
        },
        baseConfig,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("either near or bbox"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces scan caps on download resources even when contains is present", async () => {
    const rows = Array.from(
      { length: 1_001 },
      (_, index) => `A ${index};41.${String(index % 10).padStart(2, "0")};2.1`,
    );

    mockFetchResponses(
      ckanSuccess(bcnResource()),
      new Response(["name;latitud;longitud", ...rows].join("\n"), {
        headers: { "Content-Type": "text/csv" },
        status: 200,
      }),
    );

    const result = await queryBcnResourceGeo(
      {
        resource_id: "resource-1",
        bbox: { min_lat: 41, min_lon: 2, max_lat: 42, max_lon: 3 },
        contains: { name: "A" },
        limit: 10,
      },
      { ...baseConfig, bcnGeoScanMaxRows: 1_000 },
    );

    expect(result.data.truncated).toBe(true);
    expect(result.data.truncation_reason).toBe("scan_cap");
    expect(result.data.scanned_row_count).toBe(1_000);
  });
});
