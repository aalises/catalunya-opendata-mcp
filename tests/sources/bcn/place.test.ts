import { afterEach, describe, expect, it, vi } from "vitest";

import { BCN_PLACE_QUERY_MAX_CHARS, resolveBcnPlace } from "../../../src/sources/bcn/place.js";
import { baseConfig, ckanSuccess, mockFetchResponses } from "./helpers.js";

describe("resolveBcnPlace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries the BCN place registry with bounded DataStore q requests", async () => {
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

  it("skips registry resources without inferable coordinate fields", async () => {
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

function placeResponse(records: Array<Record<string, unknown>>, total = records.length): Response {
  return ckanSuccess({
    fields: [
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
  });
}
