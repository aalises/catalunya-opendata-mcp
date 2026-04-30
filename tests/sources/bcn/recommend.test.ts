import { describe, expect, it } from "vitest";

import {
  BCN_RECOMMEND_QUERY_MAX_CHARS,
  recommendBcnResources,
} from "../../../src/sources/bcn/recommend.js";
import { baseConfig } from "./helpers.js";

describe("recommendBcnResources", () => {
  it("recommends street trees for street species grouping questions", () => {
    const result = recommendBcnResources(
      {
        query: "tree species on Carrer Consell de Cent",
        task: "group",
        place_kind: "street",
        limit: 2,
      },
      baseConfig,
    );

    expect(result.data).toMatchObject({
      query: "tree species on Carrer Consell de Cent",
      task: "group",
      place_kind: "street",
      recommendation_count: 2,
      truncated: true,
    });
    expect(result.data.recommendations[0]).toMatchObject({
      title: "Street trees (Arbrat viari)",
      resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      area_source: false,
      suggested_tool: "bcn_query_resource_geo",
      suggested_contains_fields: ["adreca"],
      suggested_group_by: ["cat_nom_catala"],
      example_arguments: {
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
        contains: {
          adreca: "<street name>",
        },
        group_by: "cat_nom_catala",
        limit: 20,
      },
    });
    expect(result.data.recommendations[0]?.confidence).toBeGreaterThan(0.8);
    expect(result.provenance.id).toBe("opendata-ajuntament.barcelona.cat:resource_recommend");
  });

  it("recommends municipal facilities for near-place questions", () => {
    const result = recommendBcnResources(
      {
        query: "facilities near Sagrada Familia",
        task: "near",
        place_kind: "point",
        limit: 1,
      },
      baseConfig,
    );

    expect(result.data.recommendations).toEqual([
      expect.objectContaining({
        title: "Municipal facilities and equipment",
        datastore_active: true,
        geo_capable: true,
        suggested_tool: "bcn_query_resource_geo",
        example_arguments: expect.objectContaining({
          resource_id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          near: {
            lat: 41.4036,
            lon: 2.1744,
            radius_m: 500,
          },
        }),
      }),
    ]);
  });

  it("recommends area boundary resources for district or neighborhood queries", () => {
    const district = recommendBcnResources(
      {
        query: "district boundary for Gracia",
        task: "within",
        place_kind: "district",
        limit: 1,
      },
      baseConfig,
    );
    const neighborhood = recommendBcnResources(
      {
        query: "neighborhood polygons",
        task: "within",
        place_kind: "neighborhood",
        limit: 1,
      },
      baseConfig,
    );

    expect(district.data.recommendations[0]).toMatchObject({
      title: "Administrative districts",
      resource_id: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
      area_source: true,
      geo_capable: false,
      suggested_tool: "bcn_resolve_place",
      example_arguments: {
        query: "<district name>",
        kinds: ["district"],
        limit: 3,
      },
    });
    expect(neighborhood.data.recommendations[0]).toMatchObject({
      title: "Neighborhood boundaries",
      resource_id: "b21fa550-56ea-4f4c-9adc-b8009381896e",
      area_source: true,
      geo_capable: false,
      suggested_tool: "bcn_resolve_place",
    });
  });

  it("honors preview tasks and avoids unrelated fallback suggestions", () => {
    const preview = recommendBcnResources(
      {
        query: "tree csv preview",
        task: "preview",
        limit: 1,
      },
      baseConfig,
    );
    const unrelated = recommendBcnResources(
      {
        query: "interplanetary ferry permits",
        limit: 3,
      },
      baseConfig,
    );

    expect(preview.data.recommendations[0]).toMatchObject({
      title: "Street trees (Arbrat viari)",
      suggested_tool: "bcn_preview_resource",
      example_arguments: {
        resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
        limit: 20,
      },
    });
    expect(unrelated.data).toMatchObject({
      recommendation_count: 0,
      recommendations: [],
      truncated: false,
    });
  });

  it("caps recommendations to responseMaxBytes by dropping tail entries", () => {
    const result = recommendBcnResources(
      {
        query: "facilities trees parks fountains streets neighborhoods districts",
        limit: 7,
      },
      {
        ...baseConfig,
        responseMaxBytes: 2_000,
      },
    );

    expect(result.data.truncated).toBe(true);
    expect(result.data.recommendation_count).toBeLessThan(7);
  });

  it("rejects invalid input before doing work", () => {
    expect(() => recommendBcnResources({ query: "   " }, baseConfig)).toThrow(/query/);
    expect(() =>
      recommendBcnResources({ query: "x".repeat(BCN_RECOMMEND_QUERY_MAX_CHARS + 1) }, baseConfig),
    ).toThrow(/single line/);
    expect(() => recommendBcnResources({ query: "trees", task: "export" }, baseConfig)).toThrow(
      /Unsupported/,
    );
    expect(() =>
      recommendBcnResources({ query: "trees", place_kind: "planet" }, baseConfig),
    ).toThrow(/Unsupported/);
  });
});
