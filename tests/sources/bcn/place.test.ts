import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BCN_PLACE_QUERY_MAX_CHARS,
  BCN_PLACE_REGISTRY,
  type BcnPlaceRegistryResource,
  resolveBcnPlace,
} from "../../../src/sources/bcn/place.js";
import { baseConfig, ckanFailure, ckanSuccess, mockFetchResponses } from "./helpers.js";

const ORIGINAL_PLACE_REGISTRY = [...BCN_PLACE_REGISTRY];
const FACILITY_PLACE_RESOURCE = ORIGINAL_PLACE_REGISTRY.find(
  (resource) => resource.resourceId === "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
);

describe("resolveBcnPlace", () => {
  afterEach(() => {
    BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...ORIGINAL_PLACE_REGISTRY);
    vi.restoreAllMocks();
  });

  it("queries the BCN place registry with bounded DataStore q requests", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    const fetchMock = mockFetchResponses(
      placeResponse([
        {
          name: "Park Güell. Museu d'Història de Barcelona",
          secondary_filters_name: "Museus",
          addresses_road_name: "C Olot",
          addresses_neighborhood_name: "la Salut",
          addresses_district_name: "Gràcia",
          geo_epgs_4326_lat: "41.41350925781701",
          geo_epgs_4326_lon: "2.153127208234728",
          rank: 0.1,
        },
      ]),
    );

    const result = await resolveBcnPlace({ query: "Park", limit: 3 }, baseConfig);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://opendata-ajuntament.barcelona.cat/data/api/action/datastore_search",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      resource_id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
      q: "Park",
      limit: 12,
      fields: expect.arrayContaining([
        "name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
    });
    expect(result.data).toMatchObject({
      query: "Park",
      query_variants: ["Park"],
      strategy: "datastore",
      candidate_count: 1,
      candidates: [
        {
          name: "Park Güell. Museu d'Història de Barcelona",
          kind: "landmark",
          address: "C Olot",
          neighborhood: "la Salut",
          district: "Gràcia",
          lat: 41.41350925781701,
          lon: 2.153127208234728,
          source_resource_id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
        },
      ],
    });
    expect(result.data.candidates[0]?.matched_fields).toContain("name");
  });

  it("ranks exact name matches above substring matches", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Park Güell Annex",
          secondary_filters_name: "Biblioteques",
          geo_epgs_4326_lat: 41.41,
          geo_epgs_4326_lon: 2.15,
          rank: 0.1,
        },
        {
          name: "Park",
          secondary_filters_name: "Biblioteques",
          geo_epgs_4326_lat: 41.42,
          geo_epgs_4326_lon: 2.16,
          rank: 0.9,
        },
      ]),
    );

    const result = await resolveBcnPlace({ query: "Park", limit: 2 }, baseConfig);

    expect(result.data.candidates.map((candidate) => candidate.name)).toEqual([
      "Park",
      "Park Güell Annex",
    ]);
  });

  it("falls back to significant query tokens for accent-insensitive user input", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    const fetchMock = mockFetchResponses(
      placeResponse([]),
      placeResponse([
        {
          name: "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte",
          secondary_filters_name: "Biblioteques",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.4054,
          geo_epgs_4326_lon: 2.1767,
        },
      ]),
      placeResponse([]),
    );

    const result = await resolveBcnPlace({ query: "Sagrada Familia", limit: 2 }, baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.data.query_variants).toEqual(["Sagrada Familia", "sagrada", "familia"]);
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]).toMatchObject({
      name: "Biblioteca Sagrada Família - Josep M. Ainaud de Lasarte",
      neighborhood: "la Sagrada Família",
    });
  });

  it("applies bbox and kind filters", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Inside museum",
          secondary_filters_name: "Museus",
          geo_epgs_4326_lat: 41.4,
          geo_epgs_4326_lon: 2.17,
        },
        {
          name: "Outside museum",
          secondary_filters_name: "Museus",
          geo_epgs_4326_lat: 41.6,
          geo_epgs_4326_lon: 2.4,
        },
        {
          name: "Inside library",
          secondary_filters_name: "Biblioteques",
          geo_epgs_4326_lat: 41.4,
          geo_epgs_4326_lon: 2.17,
        },
      ]),
    );

    const result = await resolveBcnPlace(
      {
        query: "Inside",
        kinds: ["landmark"],
        bbox: { min_lat: 41.3, min_lon: 2.1, max_lat: 41.5, max_lon: 2.2 },
        limit: 5,
      },
      baseConfig,
    );

    expect(result.data.candidates.map((candidate) => candidate.name)).toEqual(["Inside museum"]);
    expect(result.data.kinds).toEqual(["landmark"]);
  });

  it("deduplicates repeated rows by normalized name and coordinates", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Biblioteca Sagrada Família",
          secondary_filters_name: "Biblioteques",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.4054156,
          geo_epgs_4326_lon: 2.1767746,
        },
        {
          name: "Biblioteca Sagrada Família",
          secondary_filters_name: "Sales d'estudi",
          addresses_neighborhood_name: "la Sagrada Família",
          geo_epgs_4326_lat: 41.40541561,
          geo_epgs_4326_lon: 2.17677465,
        },
      ]),
    );

    const result = await resolveBcnPlace({ query: "Biblioteca", limit: 5 }, baseConfig);

    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]?.matched_fields).toContain("name");
  });

  it("marks the response truncated when matching candidates exceed the requested limit", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    mockFetchResponses(
      placeResponse([
        {
          name: "Biblioteca A",
          secondary_filters_name: "Biblioteques",
          geo_epgs_4326_lat: 41.4,
          geo_epgs_4326_lon: 2.17,
        },
        {
          name: "Biblioteca B",
          secondary_filters_name: "Biblioteques",
          geo_epgs_4326_lat: 41.41,
          geo_epgs_4326_lon: 2.18,
        },
      ]),
    );

    const result = await resolveBcnPlace({ query: "Biblioteca", limit: 1 }, baseConfig);

    expect(result.data.truncated).toBe(true);
    expect(result.data.candidate_count).toBe(1);
    expect(result.data.candidates).toHaveLength(1);
  });

  it("resolves street candidates from the address registry and deduplicates by street name", async () => {
    usePlaceRegistry([
      {
        resourceId: "street-resource",
        packageId: "street-package",
        sourceDatasetName: "Address registry",
        sourceUrl:
          "https://opendata-ajuntament.barcelona.cat/data/dataset/street-package/resource/street-resource",
        defaultKind: "street",
        priority: 35,
        dedupeBy: "name",
        nameFields: ["nom_carrer"],
        addressFields: ["nom_carrer"],
        neighborhoodFields: ["nom_barri"],
        districtFields: ["nom_districte"],
        coordinateFields: { lat: "latitud_wgs84", lon: "longitud_wgs84" },
      },
    ]);
    const fetchMock = mockFetchResponses(
      datastoreResponse(
        [
          { id: "nom_carrer", type: "text" },
          { id: "nom_barri", type: "text" },
          { id: "nom_districte", type: "text" },
          { id: "latitud_wgs84", type: "numeric" },
          { id: "longitud_wgs84", type: "numeric" },
        ],
        [
          {
            nom_carrer: "Consell de Cent",
            nom_barri: "el Fort Pienc",
            nom_districte: "Eixample",
            latitud_wgs84: "41.4005354",
            longitud_wgs84: "2.1781029",
          },
          {
            nom_carrer: "Consell de Cent",
            nom_barri: "Hostafrancs",
            nom_districte: "Sants-Montjuïc",
            latitud_wgs84: "41.3760669",
            longitud_wgs84: "2.1445120",
          },
        ],
      ),
      datastoreResponse([{ id: "nom_carrer", type: "text" }], []),
      datastoreResponse([{ id: "nom_carrer", type: "text" }], []),
    );

    const result = await resolveBcnPlace(
      { query: "Carrer Consell de Cent", kinds: ["street"], limit: 5 },
      baseConfig,
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      resource_id: "street-resource",
      q: "Carrer Consell de Cent",
      fields: expect.arrayContaining(["nom_carrer", "latitud_wgs84", "longitud_wgs84"]),
    });
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]).toMatchObject({
      name: "Carrer Consell de Cent",
      kind: "street",
      address: "Consell de Cent",
      district: "Eixample",
      neighborhood: "el Fort Pienc",
      lat: 41.4005354,
      lon: 2.1781029,
      source_dataset_name: "Address registry",
    });
  });

  it("resolves neighborhoods and districts from full-scan WKT geometries", async () => {
    usePlaceRegistry([
      boundaryPlaceResource({
        resourceId: "district-resource",
        defaultKind: "district",
        nameFields: ["nom_districte"],
        districtFields: ["nom_districte"],
      }),
      boundaryPlaceResource({
        resourceId: "neighborhood-resource",
        defaultKind: "neighborhood",
        nameFields: ["nom_barri"],
        neighborhoodFields: ["nom_barri"],
        districtFields: ["nom_districte"],
      }),
    ]);
    const fetchMock = mockFetchResponses(
      datastoreResponse(
        [
          { id: "nom_districte", type: "text" },
          { id: "geometria_wgs84", type: "text" },
        ],
        [
          {
            _id: 2,
            nom_districte: "Gràcia",
            geometria_wgs84:
              "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))",
          },
        ],
      ),
      datastoreResponse(
        [
          { id: "nom_barri", type: "text" },
          { id: "nom_districte", type: "text" },
          { id: "geometria_wgs84", type: "text" },
        ],
        [
          {
            _id: 31,
            nom_barri: "la Vila de Gràcia",
            nom_districte: "Gràcia",
            geometria_wgs84:
              "POLYGON ((2.14 41.39, 2.16 41.39, 2.16 41.41, 2.14 41.41, 2.14 41.39))",
          },
        ],
      ),
    );

    const result = await resolveBcnPlace(
      { query: "Gracia", kinds: ["district", "neighborhood"], limit: 5 },
      baseConfig,
    );

    const requestBodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requestBodies).toEqual([
      expect.not.objectContaining({ q: expect.anything() }),
      expect.not.objectContaining({ q: expect.anything() }),
    ]);
    expect(result.data.candidates.map((candidate) => candidate.kind)).toEqual([
      "district",
      "neighborhood",
    ]);
    expect(result.data.candidates[0]).toMatchObject({
      name: "Gràcia",
      lat: 41.45,
      lon: 2.1500000000000004,
      bbox: {
        min_lat: 41.4,
        min_lon: 2.1,
        max_lat: 41.5,
        max_lon: 2.2,
      },
      area_ref: {
        source_resource_id: "district-resource",
        source_package_id: "boundary-package",
        row_id: 2,
        geometry_field: "geometria_wgs84",
        geometry_type: "polygon",
      },
    });
    expect(result.data.candidates[1]).toMatchObject({
      name: "la Vila de Gràcia",
      neighborhood: "la Vila de Gràcia",
      district: "Gràcia",
      lat: 41.4,
      bbox: {
        min_lat: 41.39,
        min_lon: 2.14,
        max_lat: 41.41,
        max_lon: 2.16,
      },
      area_ref: {
        source_resource_id: "neighborhood-resource",
        row_id: 31,
      },
    });
    expect(result.data.candidates[1]?.lon).toBeCloseTo(2.15);
  });

  it("isolates per-resource fetch failures when another place registry resource succeeds", async () => {
    usePlaceRegistry([
      { ...facilityPlaceResource(), resourceId: "failing-resource" },
      facilityPlaceResource(),
    ]);
    mockFetchResponses(
      ckanFailure({ message: "temporary CKAN failure" }),
      placeResponse([
        {
          name: "Park Güell. Museu d'Història de Barcelona",
          secondary_filters_name: "Museus",
          geo_epgs_4326_lat: 41.4135,
          geo_epgs_4326_lon: 2.1531,
        },
      ]),
    );

    const result = await resolveBcnPlace({ query: "Park", kinds: ["landmark"] }, baseConfig);

    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]).toMatchObject({
      name: "Park Güell. Museu d'Història de Barcelona",
      kind: "landmark",
    });
  });

  it("skips registry resources without inferable coordinate fields", async () => {
    usePlaceRegistry([facilityPlaceResource()]);
    mockFetchResponses(
      ckanSuccess({
        fields: [{ id: "name", type: "text" }],
        records: [{ name: "Park" }],
        total: 1,
      }),
    );

    const result = await resolveBcnPlace({ query: "Park", limit: 5 }, baseConfig);

    expect(result.data.candidates).toEqual([]);
    expect(result.data.candidate_count).toBe(0);
  });

  it("rejects invalid input before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));

    await expect(resolveBcnPlace({ query: "   " }, baseConfig)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("query"),
    });
    await expect(
      resolveBcnPlace({ query: "x".repeat(BCN_PLACE_QUERY_MAX_CHARS + 1) }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      resolveBcnPlace({ query: "Park", kinds: ["planet"] }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
      source_error: {
        allowed_kinds: expect.arrayContaining(["facility", "landmark"]),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function usePlaceRegistry(resources: BcnPlaceRegistryResource[]): void {
  BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...resources);
}

function facilityPlaceResource(): BcnPlaceRegistryResource {
  if (!FACILITY_PLACE_RESOURCE) {
    throw new Error("Expected BCN facility place registry resource to exist.");
  }

  return FACILITY_PLACE_RESOURCE;
}

function boundaryPlaceResource(
  overrides: Partial<BcnPlaceRegistryResource>,
): BcnPlaceRegistryResource {
  return {
    resourceId: "boundary-resource",
    packageId: "boundary-package",
    sourceDatasetName: "Boundary registry",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/boundary-package/resource/boundary-resource",
    defaultKind: "district",
    priority: 40,
    dedupeBy: "name",
    searchMode: "full_scan",
    rowLimit: 100,
    nameFields: ["nom_districte"],
    geometryField: "geometria_wgs84",
    ...overrides,
  };
}

function placeResponse(records: Array<Record<string, unknown>>, total = records.length): Response {
  return datastoreResponse(
    [
      { id: "name", type: "text" },
      { id: "institution_name", type: "text" },
      { id: "addresses_road_name", type: "text" },
      { id: "addresses_neighborhood_name", type: "text" },
      { id: "addresses_district_name", type: "text" },
      { id: "secondary_filters_name", type: "text" },
      { id: "geo_epgs_4326_lat", type: "numeric" },
      { id: "geo_epgs_4326_lon", type: "numeric" },
      { id: "rank", type: "float4" },
    ],
    records,
    total,
  );
}

function datastoreResponse(
  fields: Array<{ id: string; type: string }>,
  records: Array<Record<string, unknown>>,
  total = records.length,
): Response {
  return ckanSuccess({
    fields,
    records,
    total,
  });
}
