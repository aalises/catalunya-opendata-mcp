import { afterEach, describe, expect, it, vi } from "vitest";

import { answerBcnCityQuery } from "../../../src/sources/bcn/city-answer.js";
import { executeBcnCityQuery, planBcnCityQuery } from "../../../src/sources/bcn/city-query.js";
import {
  BCN_PLACE_REGISTRY,
  type BcnPlaceRegistryResource,
} from "../../../src/sources/bcn/place.js";
import { baseConfig, bcnResource, ckanSuccess, mockFetchResponses } from "./helpers.js";

const ORIGINAL_PLACE_REGISTRY = [...BCN_PLACE_REGISTRY];
const ADDRESS_PLACE_RESOURCE = mustFindPlaceResource("661fe190-67c8-423a-b8eb-8140f547fde2");
const FACILITY_PLACE_RESOURCE = mustFindPlaceResource("d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7");
const DISTRICT_PLACE_RESOURCE = mustFindPlaceResource("576bc645-9481-4bc4-b8bf-f5972c20df3f");
const NEIGHBORHOOD_PLACE_RESOURCE = mustFindPlaceResource("b21fa550-56ea-4f4c-9adc-b8009381896e");

describe("BCN city query planner", () => {
  afterEach(() => {
    BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...ORIGINAL_PLACE_REGISTRY);
    vi.restoreAllMocks();
  });

  it("plans street species questions as contains plus grouping", async () => {
    const result = await planBcnCityQuery(
      { query: "tree species on Carrer Consell de Cent" },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      intent: {
        task: "group",
        spatial_mode: "contains",
        place_kind: "street",
        place_query: "Carrer Consell de Cent",
      },
      recommendation: {
        title: "Street trees (Arbrat viari)",
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      },
      final_tool: "bcn_query_resource_geo",
      final_arguments: {
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
        contains: {
          adreca: "Carrer Consell de Cent",
        },
        group_by: "cat_nom_catala",
        limit: 10,
      },
    });
    expect(result.data.steps.map((step) => step.tool)).toEqual([
      "bcn_recommend_resources",
      "bcn_query_resource_geo",
    ]);
  });

  it("executes ready street grouping plans with one bounded geo query", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
          datastore_active: false,
          format: "CSV",
          mimetype: "text/csv",
          url: "https://opendata-ajuntament.barcelona.cat/download/arbrat.csv",
        }),
      ),
      csvResponse(
        [
          "adreca;cat_nom_catala;latitud;longitud",
          "Carrer Consell de Cent 1;Plataner;41.39;2.16",
          "Carrer Consell de Cent 2;Lledoner;41.391;2.161",
          "Carrer Mallorca 1;Om;41.40;2.17",
        ].join("\n"),
      ),
    );

    const result = await executeBcnCityQuery(
      { query: "tree species on Carrer Consell de Cent", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      execution_status: "completed",
      final_tool: "bcn_query_resource_geo",
      final_result: {
        data: {
          strategy: "download_stream",
          matched_row_count: 2,
        },
      },
    });
    expect(result.data.final_result?.data).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ key: "Lledoner", count: 1 }),
        expect.objectContaining({ key: "Plataner", count: 1 }),
      ]),
    });
  });

  it("executes near-place questions through source-bounded place resolution", async () => {
    usePlaceRegistry([FACILITY_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Sagrada Família",
          secondary_filters_name: "Monuments",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.4032,
          geo_epgs_4326_lon: 2.1748,
        },
      ]),
      placeResponse([]),
      placeResponse([]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [
          {
            name: "Library",
            addresses_road_name: "C Mallorca",
            addresses_neighborhood_name: "la Sagrada Família",
            geo_epgs_4326_lat: 41.40325,
            geo_epgs_4326_lon: 2.17485,
            _bcn_distance_m: 8,
            _bcn_matched_total: 1,
          },
        ],
      }),
    );

    const result = await executeBcnCityQuery(
      { query: "facilities near Sagrada Família", limit: 3 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      execution_status: "completed",
      plan: {
        intent: {
          spatial_mode: "near",
          place_query: "Sagrada Família",
        },
        place_resolution: {
          selected_candidate: {
            kind: "landmark",
            name: "Sagrada Família",
          },
        },
      },
      final_result: {
        data: {
          datastore_mode: "sql",
          near: {
            lat: 41.4032,
            lon: 2.1748,
            radius_m: 500,
          },
          row_count: 1,
        },
      },
    });
  });

  it("executes district area questions with within_place and grouping", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    const geometry = "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))";
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: geometry }]),
      placeResponse([{ _id: 6, geometria_wgs84: geometry }]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [
          {
            name: "Facility 1",
            addresses_neighborhood_name: "Vila de Gràcia",
            addresses_district_name: "Gràcia",
            geo_epgs_4326_lat: 41.45,
            geo_epgs_4326_lon: 2.15,
            _bcn_matched_total: 1,
          },
        ],
      }),
    );

    const result = await executeBcnCityQuery(
      { query: "count facilities in Gràcia by neighborhood", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      execution_status: "completed",
      final_arguments: {
        within_place: {
          source_resource_id: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
          row_id: 6,
        },
        group_by: "addresses_neighborhood_name",
      },
      final_result: {
        data: {
          area_filter: {
            row_id: 6,
          },
          groups: [{ key: "Vila de Gràcia", count: 1 }],
        },
      },
    });
  });

  it("blocks when place resolution is ambiguous across kinds", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE, NEIGHBORHOOD_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
      placeResponse([{ _id: 31, nom_barri: "Gràcia", geometria_wgs84: smallPolygon() }]),
    );

    const result = await executeBcnCityQuery(
      { query: "facilities in Gracia", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      execution_status: "blocked",
      plan: {
        status: "needs_place_selection",
        place_resolution: {
          candidate_count: 2,
        },
      },
    });
    expect(result.data.final_result).toBeUndefined();
  });

  it("uses explicit place_kind to unblock cross-kind area matches", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE, NEIGHBORHOOD_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
      placeResponse([{ _id: 31, nom_barri: "Gràcia", geometria_wgs84: smallPolygon() }]),
    );

    const result = await planBcnCityQuery(
      { query: "facilities in Gracia", place_kind: "district", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      place_resolution: {
        selected_candidate: {
          kind: "district",
          name: "Gràcia",
        },
      },
      final_arguments: {
        within_place: {
          source_resource_id: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
          row_id: 6,
        },
      },
    });
  });

  it("lets explicit point place_kind beat within wording", async () => {
    usePlaceRegistry([FACILITY_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Sagrada Família",
          secondary_filters_name: "Monuments",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.4032,
          geo_epgs_4326_lon: 2.1748,
        },
      ]),
      placeResponse([]),
      placeResponse([]),
    );

    const result = await planBcnCityQuery(
      {
        query: "facilities in Sagrada Família",
        place_kind: "point",
        place_query: "Sagrada Família",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      intent: {
        spatial_mode: "near",
        place_kind: "point",
      },
      place_resolution: {
        selected_candidate: {
          kind: "landmark",
          name: "Sagrada Família",
        },
      },
      final_arguments: {
        near: {
          lat: 41.4032,
          lon: 2.1748,
        },
      },
    });
  });

  it("uses explicit place_query even when the text has no spatial keyword", async () => {
    usePlaceRegistry([FACILITY_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Sagrada Família",
          secondary_filters_name: "Monuments",
          geo_epgs_4326_lat: 41.4032,
          geo_epgs_4326_lon: 2.1748,
        },
      ]),
      placeResponse([]),
      placeResponse([]),
    );

    const result = await planBcnCityQuery(
      {
        query: "facilities",
        place_kind: "point",
        place_query: "Sagrada Família",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      intent: {
        spatial_mode: "near",
        place_query: "Sagrada Família",
      },
      final_tool: "bcn_query_resource_geo",
      final_arguments: {
        near: {
          lat: 41.4032,
          lon: 2.1748,
        },
      },
    });
  });

  it("maps explicit street place_kind through to the place resolver for near plans", async () => {
    usePlaceRegistry([ADDRESS_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          nom_carrer: "Carrer Consell de Cent",
          nom_barri: "la Dreta de l'Eixample",
          nom_districte: "Eixample",
          latitud_wgs84: 41.39,
          longitud_wgs84: 2.16,
        },
      ]),
      placeResponse([]),
      placeResponse([]),
    );

    const result = await planBcnCityQuery(
      {
        query: "facilities near Carrer Consell de Cent",
        place_kind: "street",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      place_resolution: {
        selected_candidate: {
          kind: "street",
          name: "Carrer Consell de Cent",
        },
      },
      final_arguments: {
        near: {
          lat: 41.39,
          lon: 2.16,
        },
      },
    });
  });

  it("plans within queries for download-only coordinate resources", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
    );

    const result = await planBcnCityQuery(
      {
        query: "tree species in Gracia district",
        task: "group",
        place_kind: "district",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      recommendation: {
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
        datastore_active: false,
      },
      final_tool: "bcn_query_resource_geo",
      final_arguments: {
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
        within_place: {
          source_resource_id: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
          row_id: 6,
        },
        group_by: "cat_nom_catala",
      },
    });
  });

  it("adds a caveat when area plans fall back to bbox", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          nom_districte: "Gràcia",
          geometria_wgs84: smallPolygon(),
        },
      ]),
    );

    const result = await planBcnCityQuery(
      {
        query: "facilities in Gracia",
        place_kind: "district",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "ready",
      final_arguments: {
        bbox: {
          min_lat: 41.4,
          min_lon: 2.1,
          max_lat: 41.5,
          max_lon: 2.2,
        },
      },
    });
    expect(result.data.intent.caveats).toContain(
      "Area candidate did not expose an area_ref; using its bbox as an approximate rectangular fallback.",
    );
  });

  it("blocks resource overrides that cannot support geo querying", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "resource-1",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse(["name", "description"]),
    );

    const result = await planBcnCityQuery(
      {
        query: "facilities near Sagrada Família",
        resource_id: "resource-1",
        task: "near",
        place_query: "Sagrada Família",
        place_kind: "point",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "unsupported",
      resource_override: {
        resource_id: "resource-1",
        datastore_active: true,
      },
    });
    expect(result.data.intent.caveats).toContain(
      "The caller-provided DataStore resource does not expose an inferable WGS84 latitude/longitude field pair for geo querying.",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("passes q, sort, and offset through executor query plans", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "resource-1",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse(["name", "geo_epgs_4326_lat", "geo_epgs_4326_lon"]),
      ckanSuccess({
        fields: [{ id: "name", type: "text" }],
        records: [],
        total: 0,
      }),
    );

    const result = await executeBcnCityQuery(
      {
        query: "facilities",
        resource_id: "resource-1",
        task: "query",
        q: "library",
        sort: "name asc",
        offset: 25,
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      execution_status: "completed",
      final_tool: "bcn_query_resource",
      final_arguments: {
        q: "library",
        sort: "name asc",
        offset: 25,
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      q: "library",
      sort: "name asc",
      offset: 25,
    });
  });

  it("does not treat generic in/on date phrases as spatial intent", async () => {
    const dataIn2024 = await planBcnCityQuery({ query: "facility data in 2024" }, baseConfig);
    const rentedOnDate = await planBcnCityQuery({ query: "facilities rented on 2024" }, baseConfig);

    expect(dataIn2024.data.intent.spatial_mode).toBe("query");
    expect(rentedOnDate.data.intent.spatial_mode).toBe("query");
  });

  it("does not return area-source-only recommendations as target resources", async () => {
    const result = await planBcnCityQuery(
      {
        query: "district boundary",
        task: "within",
        place_kind: "district",
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "unsupported",
      recommendations: [],
      steps: [],
    });
  });

  it("returns unsupported when the curated recommender has no suitable resource", async () => {
    const result = await planBcnCityQuery(
      { query: "interplanetary ferry permits", limit: 3 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      status: "unsupported",
      recommendations: [],
      steps: [],
    });
  });
});

describe("BCN city answer composer", () => {
  afterEach(() => {
    BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...ORIGINAL_PLACE_REGISTRY);
    vi.restoreAllMocks();
  });

  it("summarizes street tree species groups", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
          datastore_active: false,
          format: "CSV",
          mimetype: "text/csv",
          url: "https://opendata-ajuntament.barcelona.cat/download/arbrat.csv",
        }),
      ),
      csvResponse(
        [
          "adreca;cat_nom_catala;latitud;longitud",
          "Carrer Consell de Cent 1;Plataner;41.39;2.16",
          "Carrer Consell de Cent 2;Plataner;41.391;2.161",
          "Carrer Consell de Cent 3;Lledoner;41.392;2.162",
          "Carrer Mallorca 1;Om;41.40;2.17",
        ].join("\n"),
      ),
    );

    const result = await answerBcnCityQuery(
      { query: "tree species on Carrer Consell de Cent", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      answer_type: "grouped_counts",
      execution_status: "completed",
      selected_resource: {
        title: "Street trees (Arbrat viari)",
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      },
      summary: {
        group_by: "cat_nom_catala",
        matched_row_count: 3,
        groups: [
          { key: "Plataner", count: 2 },
          { key: "Lledoner", count: 1 },
        ],
      },
    });
    expect(result.data.answer_text).toContain("Plataner (2)");
    expect(result.data.answer_text).toContain("Lledoner (1)");
    expect(result.data.answer_markdown).toContain("| cat\\_nom\\_catala | Count |");
    expect(result.data.answer_markdown).toContain("| Plataner | 2 |");
    expect(result.data.final_result?.data).toMatchObject({
      matched_row_count: 3,
    });
  });

  it("summarizes nearest facilities ordered by distance", async () => {
    usePlaceRegistry([FACILITY_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Sagrada Família",
          secondary_filters_name: "Monuments",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.4032,
          geo_epgs_4326_lon: 2.1748,
        },
      ]),
      placeResponse([]),
      placeResponse([]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [
          {
            name: "Library",
            addresses_road_name: "C Mallorca",
            addresses_neighborhood_name: "la Sagrada Família",
            geo_epgs_4326_lat: 41.40325,
            geo_epgs_4326_lon: 2.17485,
            _bcn_distance_m: 8,
            _bcn_matched_total: 2,
          },
          {
            name: "Museum",
            addresses_road_name: "C Mallorca",
            addresses_neighborhood_name: "la Sagrada Família",
            geo_epgs_4326_lat: 41.4035,
            geo_epgs_4326_lon: 2.175,
            _bcn_distance_m: 42,
            _bcn_matched_total: 2,
          },
        ],
      }),
    );

    const result = await answerBcnCityQuery(
      { query: "facilities near Sagrada Família", limit: 2 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      answer_type: "nearest_rows",
      summary: {
        matched_row_count: 2,
        rows: [
          {
            label: "Library",
            distance_m: 7,
            source_row: { name: "Library", addresses_road_name: "C Mallorca" },
          },
          {
            label: "Museum",
            distance_m: 37,
            source_row: { name: "Museum", addresses_road_name: "C Mallorca" },
          },
        ],
      },
    });
    expect(result.data.answer_text).toContain("Library (7 m)");
    expect(result.data.answer_text).toContain("Museum (37 m)");
    expect(result.data.answer_markdown).toContain("| Result | Distance (m) |");
    expect(result.data.answer_markdown).toContain("| Library | 7 |");
    expect(result.data.caveats).not.toContain(
      "Spatial narrowing used generated CKAN datastore_search_sql pushdown.",
    );
    expect(result.data.execution_notes).toContain(
      "Spatial narrowing used generated CKAN datastore_search_sql pushdown.",
    );
  });

  it("summarizes grouped facilities in an area with area provenance", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    const geometry = smallPolygon();
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: geometry }]),
      placeResponse([{ _id: 6, geometria_wgs84: geometry }]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [
          {
            name: "Facility 1",
            addresses_neighborhood_name: "Vila de Gràcia",
            addresses_district_name: "Gràcia",
            geo_epgs_4326_lat: 41.45,
            geo_epgs_4326_lon: 2.15,
            _bcn_matched_total: 1,
          },
        ],
      }),
    );

    const result = await answerBcnCityQuery(
      { query: "count facilities in Gràcia by neighborhood", limit: 5 },
      baseConfig,
    );

    expect(result.data.answer_type).toBe("grouped_counts");
    expect(result.data.answer_text).toContain("Vila de Gràcia (1)");
    expect(result.data.answer_text).toContain(
      "Area provenance: district Gràcia from Open Data BCN administrative districts row 6.",
    );
    expect(result.data.summary).toMatchObject({
      place: {
        name: "Gràcia",
        kind: "district",
      },
    });
  });

  it("includes bbox fallback caveats", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [],
      }),
    );

    const result = await answerBcnCityQuery(
      {
        query: "facilities in Gracia",
        place_kind: "district",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data.answer_type).toBe("empty_result");
    expect(result.data.caveats).toEqual(
      expect.arrayContaining([
        "Area candidate did not expose an area_ref; using its bbox as an approximate rectangular fallback.",
        "Area query used a bbox fallback, so results are based on a rectangular approximation.",
      ]),
    );
  });

  it("splits truncation caveats from scan execution notes", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
          datastore_active: false,
          format: "CSV",
          mimetype: "text/csv",
          url: "https://opendata-ajuntament.barcelona.cat/download/arbrat.csv",
        }),
      ),
      csvResponse(
        [
          "adreca;cat_nom_catala;latitud;longitud",
          "Carrer Consell de Cent 1;Plataner;41.39;2.16",
          "Carrer Consell de Cent 2;Lledoner;41.391;2.161",
        ].join("\n"),
      ),
    );

    const result = await answerBcnCityQuery(
      { query: "tree species on Carrer Consell de Cent", limit: 1 },
      baseConfig,
    );

    expect(result.data.answer_type).toBe("grouped_counts");
    expect(result.data.caveats).toEqual(
      expect.arrayContaining([
        "Final result was truncated because of row_cap: raise limit within maxResults or use offset to page through matched rows",
      ]),
    );
    expect(result.data.caveats).not.toContain(
      "Final query used a bounded BCN-hosted download scan; configured byte and row caps apply.",
    );
    expect(result.data.execution_notes).toEqual(
      expect.arrayContaining([
        "Not DataStore-active; geospatial queries use safe bounded CSV download scans.",
        "Final query used a bounded BCN-hosted download scan; configured byte and row caps apply.",
      ]),
    );
  });

  it("returns blocked answers without fabricating final results", async () => {
    usePlaceRegistry([DISTRICT_PLACE_RESOURCE, NEIGHBORHOOD_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ _id: 6, nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
      placeResponse([{ _id: 31, nom_barri: "Gràcia", geometria_wgs84: smallPolygon() }]),
    );

    const result = await answerBcnCityQuery(
      { query: "facilities in Gracia", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      answer_type: "blocked",
      execution_status: "blocked",
      final_result: null,
      selection_options: {
        selection_type: "place",
        options: [
          {
            id: "place:district:576bc645-9481-4bc4-b8bf-f5972c20df3f:6",
            label: "Gràcia (district)",
            kind: "district",
            provenance: {
              source_resource_id: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
              area_ref: {
                row_id: 6,
              },
            },
            resume_arguments: {
              query: "facilities in Gracia",
              task: "within",
              place_kind: "district",
              place_query: "Gràcia",
              limit: 5,
            },
          },
          {
            id: "place:neighborhood:b21fa550-56ea-4f4c-9adc-b8009381896e:31",
            label: "Gràcia (neighborhood)",
            kind: "neighborhood",
            provenance: {
              source_resource_id: "b21fa550-56ea-4f4c-9adc-b8009381896e",
              area_ref: {
                row_id: 31,
              },
            },
            resume_arguments: {
              query: "facilities in Gracia",
              task: "within",
              place_kind: "neighborhood",
              place_query: "Gràcia",
              limit: 5,
            },
          },
        ],
      },
      summary: {
        place_candidate_count: 2,
      },
    });
    expect(result.data.answer_text).toContain("select one Barcelona place candidate");
    expect(result.data.selection_options?.options[0]?.confidence).toBeGreaterThan(0);
  });

  it("returns empty-result answers", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
          datastore_active: false,
          format: "CSV",
          mimetype: "text/csv",
          url: "https://opendata-ajuntament.barcelona.cat/download/arbrat.csv",
        }),
      ),
      csvResponse(
        ["adreca;cat_nom_catala;latitud;longitud", "Carrer Mallorca 1;Om;41.40;2.17"].join("\n"),
      ),
    );

    const result = await answerBcnCityQuery(
      { query: "tree species on Carrer Consell de Cent", limit: 5 },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      answer_type: "empty_result",
      summary: {
        matched_row_count: 0,
        row_count: 0,
      },
    });
    expect(result.data.answer_text).toContain("No rows matched");
    expect(result.data.answer_markdown).toContain("No rows matched");
    expect(result.data.final_result?.data).toMatchObject({
      groups: [],
      matched_row_count: 0,
    });
  });

  it("uses _id as the stable row label fallback and avoids non-partial scan caveats", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          id: "resource-1",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse(["_id", "geo_epgs_4326_lat", "geo_epgs_4326_lon"]),
      ckanSuccess({
        fields: [
          { id: "_id", type: "int" },
          { id: "geo_epgs_4326_lat", type: "numeric" },
          { id: "geo_epgs_4326_lon", type: "numeric" },
        ],
        records: [{ _id: 42, geo_epgs_4326_lat: 41.4, geo_epgs_4326_lon: 2.1 }],
        total: 1,
      }),
    );

    const result = await answerBcnCityQuery(
      {
        query: "facilities",
        resource_id: "resource-1",
        task: "query",
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      answer_type: "row_sample",
      answer_text: expect.stringContaining("42"),
      summary: {
        rows: [
          {
            label: "42",
          },
        ],
      },
    });
    expect(result.data.caveats).not.toContain("Final query used bounded DataStore scan mode.");
  });
});

function usePlaceRegistry(resources: BcnPlaceRegistryResource[]): void {
  BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...resources);
}

function mustFindPlaceResource(resourceId: string): BcnPlaceRegistryResource {
  const resource = ORIGINAL_PLACE_REGISTRY.find((candidate) => candidate.resourceId === resourceId);

  if (!resource) {
    throw new Error(`Missing test place resource ${resourceId}`);
  }

  return resource;
}

function placeResponse(records: Array<Record<string, unknown>>): Response {
  return ckanSuccess({
    fields: Object.keys(records[0] ?? {}).map((id) => ({ id, type: "text" })),
    records,
    total: records.length,
  });
}

function datastoreFieldsResponse(fields: string[]): Response {
  return ckanSuccess({
    fields: fields.map((id) => ({ id, type: "text" })),
    records: [],
    total: 0,
  });
}

function csvResponse(text: string): Response {
  return new Response(text, {
    headers: { "Content-Type": "text/csv; charset=utf-8" },
    status: 200,
  });
}

function smallPolygon(): string {
  return "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))";
}
