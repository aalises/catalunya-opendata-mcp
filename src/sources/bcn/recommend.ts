import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength } from "../common/caps.js";
import type { JsonValue } from "../common/json-safe.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeLimit,
} from "./catalog.js";
import { BcnError, buildBcnActionUrl } from "./client.js";
import { normalizeBcnGeoText } from "./geo.js";

export const BCN_RECOMMEND_QUERY_MAX_CHARS = 200;

export type BcnResourceRecommendationTask =
  | "near"
  | "within"
  | "count"
  | "group"
  | "preview"
  | "query";
export type BcnResourceRecommendationPlaceKind = "point" | "street" | "neighborhood" | "district";
export type BcnRecommendedTool =
  | "bcn_get_resource_info"
  | "bcn_preview_resource"
  | "bcn_query_resource"
  | "bcn_query_resource_geo"
  | "bcn_resolve_place";

export interface BcnRecommendResourcesInput {
  limit?: number;
  place_kind?: string;
  query: string;
  task?: string;
}

export interface BcnResourceRecommendation {
  area_source: boolean;
  caveats: string[];
  confidence: number;
  datastore_active: boolean;
  description: string;
  example_arguments: Record<string, JsonValue>;
  format: string;
  geo_capable: boolean;
  matched_terms: string[];
  package_id: string;
  resource_id: string;
  source_url: string;
  suggested_contains_fields?: string[];
  suggested_fields: string[];
  suggested_group_by?: string[];
  suggested_tool: BcnRecommendedTool;
  theme: string;
  title: string;
}

export interface BcnRecommendResourcesData {
  limit: number;
  normalized_query: string;
  place_kind?: BcnResourceRecommendationPlaceKind;
  query: string;
  recommendation_count: number;
  recommendations: BcnResourceRecommendation[];
  task?: BcnResourceRecommendationTask;
  truncated: boolean;
}

export interface BcnRecommendResourcesResult {
  data: BcnRecommendResourcesData;
  provenance: BcnOperationProvenance;
}

interface NormalizedRecommendResourcesInput {
  limit: number;
  normalizedQuery: string;
  place_kind?: BcnResourceRecommendationPlaceKind;
  query: string;
  task?: BcnResourceRecommendationTask;
}

interface RegistryRecommendation {
  areaSource?: boolean;
  caveats?: string[];
  datastoreActive: boolean;
  description: string;
  format: string;
  geoCapable: boolean;
  keywords: string[];
  packageId: string;
  placeKinds: BcnResourceRecommendationPlaceKind[];
  preferredTasks: BcnResourceRecommendationTask[];
  resourceId: string;
  sourceUrl: string;
  suggestedContainsFields?: string[];
  suggestedFields: string[];
  suggestedGroupBy?: string[];
  theme: string;
  title: string;
}

interface ScoredRecommendation {
  matchedTerms: string[];
  recommendation: RegistryRecommendation;
  score: number;
}

const TASK_VALUES = new Set<BcnResourceRecommendationTask>([
  "near",
  "within",
  "count",
  "group",
  "preview",
  "query",
]);
const PLACE_KIND_VALUES = new Set<BcnResourceRecommendationPlaceKind>([
  "point",
  "street",
  "neighborhood",
  "district",
]);

// Curated, source-bounded shortcuts over high-value BCN resources. This is a
// recommender, not a replacement for package search, so it stays deterministic.
export const BCN_RESOURCE_RECOMMENDATION_REGISTRY: RegistryRecommendation[] = [
  {
    title: "Street trees (Arbrat viari)",
    theme: "street_trees",
    description:
      "Street tree inventory with WGS84 coordinates, street address, and species fields.",
    packageId: "27b3f8a7-e536-4eea-b025-ce094817b2bd",
    resourceId: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/27b3f8a7-e536-4eea-b025-ce094817b2bd/resource/23124fd5-521f-40f8-85b8-efb1e71c2ec8",
    datastoreActive: false,
    format: "CSV",
    geoCapable: true,
    keywords: [
      "arbrat",
      "arbre",
      "arbres",
      "tree",
      "trees",
      "species",
      "especies",
      "espècies",
      "viari",
      "street trees",
      "consell de cent",
    ],
    placeKinds: ["point", "street", "neighborhood", "district"],
    preferredTasks: ["near", "within", "count", "group", "preview"],
    suggestedFields: ["adreca", "cat_nom_catala", "latitud", "longitud"],
    suggestedContainsFields: ["adreca"],
    suggestedGroupBy: ["cat_nom_catala"],
    caveats: ["Not DataStore-active; geospatial queries use safe bounded CSV download scans."],
  },
  {
    title: "Municipal facilities and equipment",
    theme: "facilities",
    description:
      "Municipal facilities with names, categories, addresses, districts, neighborhoods, and WGS84 coordinates.",
    packageId: "fcef8a36-64df-4231-9145-a4a3ef757f02",
    resourceId: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/fcef8a36-64df-4231-9145-a4a3ef757f02/resource/d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: true,
    keywords: [
      "equipaments",
      "equipment",
      "facilities",
      "facility",
      "biblioteca",
      "library",
      "libraries",
      "museum",
      "museu",
      "schools",
      "centres",
      "services",
    ],
    placeKinds: ["point", "street", "neighborhood", "district"],
    preferredTasks: ["near", "within", "count", "group", "query"],
    suggestedFields: [
      "name",
      "secondary_filters_name",
      "addresses_road_name",
      "addresses_neighborhood_name",
      "addresses_district_name",
      "geo_epgs_4326_lat",
      "geo_epgs_4326_lon",
    ],
    suggestedContainsFields: ["name", "addresses_road_name", "addresses_neighborhood_name"],
    suggestedGroupBy: [
      "secondary_filters_name",
      "addresses_neighborhood_name",
      "addresses_district_name",
    ],
  },
  {
    title: "Parks and gardens",
    theme: "parks_gardens",
    description:
      "Parks and gardens with names, categories, addresses, neighborhoods, and WGS84 coordinates.",
    packageId: "5d43ed16-f93a-442f-8853-4bf2191b2d39",
    resourceId: "b64d32a8-aea5-47a8-9826-479b211f5d46",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/5d43ed16-f93a-442f-8853-4bf2191b2d39/resource/b64d32a8-aea5-47a8-9826-479b211f5d46",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: true,
    keywords: ["parks", "parcs", "gardens", "jardins", "green", "zones verdes", "park"],
    placeKinds: ["point", "street", "neighborhood", "district"],
    preferredTasks: ["near", "within", "count", "group", "query"],
    suggestedFields: [
      "name",
      "secondary_filters_name",
      "addresses_road_name",
      "addresses_neighborhood_name",
      "addresses_district_name",
      "geo_epgs_4326_lat",
      "geo_epgs_4326_lon",
    ],
    suggestedContainsFields: ["name", "addresses_road_name", "addresses_neighborhood_name"],
    suggestedGroupBy: ["addresses_neighborhood_name", "addresses_district_name"],
  },
  {
    title: "Building address registry",
    theme: "addresses_streets",
    description: "Street/address points with neighborhood and district labels.",
    packageId: "25752522-3528-4c14-b68d-5f09a3e393bd",
    resourceId: "661fe190-67c8-423a-b8eb-8140f547fde2",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/25752522-3528-4c14-b68d-5f09a3e393bd/resource/661fe190-67c8-423a-b8eb-8140f547fde2",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: true,
    keywords: [
      "address",
      "addresses",
      "adreca",
      "adreces",
      "street",
      "streets",
      "carrer",
      "carrers",
    ],
    placeKinds: ["point", "street", "neighborhood", "district"],
    preferredTasks: ["near", "within", "query"],
    suggestedFields: [
      "nom_carrer",
      "nom_barri",
      "nom_districte",
      "latitud_wgs84",
      "longitud_wgs84",
    ],
    suggestedContainsFields: ["nom_carrer", "nom_barri", "nom_districte"],
    suggestedGroupBy: ["nom_barri", "nom_districte"],
  },
  {
    title: "Administrative districts",
    theme: "district_boundaries",
    description: "District boundary polygons for area resolution and within-district queries.",
    packageId: "808daafa-d9ce-48c0-925a-fa5afdb1ed41",
    resourceId: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/808daafa-d9ce-48c0-925a-fa5afdb1ed41/resource/576bc645-9481-4bc4-b8bf-f5972c20df3f",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: false,
    areaSource: true,
    keywords: [
      "district",
      "districts",
      "districte",
      "districtes",
      "boundary",
      "boundaries",
      "area",
    ],
    placeKinds: ["district"],
    preferredTasks: ["within", "query"],
    suggestedFields: ["nom_districte", "geometria_wgs84"],
    suggestedContainsFields: ["nom_districte"],
    caveats: [
      "Boundary resource for bcn_resolve_place area_ref generation; do not use it as a bcn_query_resource_geo target resource.",
    ],
  },
  {
    title: "Neighborhood boundaries",
    theme: "neighborhood_boundaries",
    description:
      "Neighborhood boundary polygons for area resolution and within-neighborhood queries.",
    packageId: "808daafa-d9ce-48c0-925a-fa5afdb1ed41",
    resourceId: "b21fa550-56ea-4f4c-9adc-b8009381896e",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/808daafa-d9ce-48c0-925a-fa5afdb1ed41/resource/b21fa550-56ea-4f4c-9adc-b8009381896e",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: false,
    areaSource: true,
    keywords: [
      "neighborhood",
      "neighborhoods",
      "barri",
      "barris",
      "boundary",
      "boundaries",
      "area",
    ],
    placeKinds: ["neighborhood"],
    preferredTasks: ["within", "query"],
    suggestedFields: ["nom_barri", "nom_districte", "geometria_wgs84"],
    suggestedContainsFields: ["nom_barri", "nom_districte"],
    caveats: [
      "Boundary resource for bcn_resolve_place area_ref generation; do not use it as a bcn_query_resource_geo target resource.",
    ],
  },
  {
    title: "Drinking fountains",
    theme: "fountains",
    description: "Public drinking fountains with locations and basic metadata.",
    packageId: "889c583e-6c11-46c3-bc45-7f3ae5e6c621",
    resourceId: "8f63c3cf-399a-4a8d-a73d-eb1fca80d7f0",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/889c583e-6c11-46c3-bc45-7f3ae5e6c621/resource/8f63c3cf-399a-4a8d-a73d-eb1fca80d7f0",
    datastoreActive: true,
    format: "DataStore",
    geoCapable: true,
    keywords: ["fountain", "fountains", "font", "fonts", "drinking water", "water"],
    placeKinds: ["point", "street", "neighborhood", "district"],
    preferredTasks: ["near", "within", "count", "query"],
    suggestedFields: [
      "name",
      "addresses_road_name",
      "addresses_neighborhood_name",
      "geo_epgs_4326_lat",
      "geo_epgs_4326_lon",
    ],
    suggestedContainsFields: ["name", "addresses_road_name", "addresses_neighborhood_name"],
    suggestedGroupBy: ["addresses_neighborhood_name", "addresses_district_name"],
  },
];

export function recommendBcnResources(
  input: BcnRecommendResourcesInput,
  config: AppConfig,
): BcnRecommendResourcesResult {
  const normalized = normalizeRecommendResourcesInput(input, config);
  const provenance = createBcnOperationProvenance(
    "resource_recommend",
    buildBcnActionUrl("package_search"),
  );
  const scored = BCN_RESOURCE_RECOMMENDATION_REGISTRY.map((recommendation) =>
    scoreRecommendation(recommendation, normalized),
  )
    .filter((item) => item.score > 0)
    .sort(compareScoredRecommendations);
  const selected = scored
    .slice(0, normalized.limit)
    .map((item) => toPublicRecommendation(item, normalized));
  const data = capRecommendData(
    {
      query: normalized.query,
      normalized_query: normalized.normalizedQuery,
      ...(normalized.task ? { task: normalized.task } : {}),
      ...(normalized.place_kind ? { place_kind: normalized.place_kind } : {}),
      limit: normalized.limit,
      recommendation_count: selected.length,
      recommendations: selected,
      truncated: scored.length > selected.length,
    },
    provenance,
    config.responseMaxBytes,
  );

  return { data, provenance };
}

function normalizeRecommendResourcesInput(
  input: BcnRecommendResourcesInput,
  config: AppConfig,
): NormalizedRecommendResourcesInput {
  const query = input.query.trim();

  if (!query) {
    throw new BcnError("invalid_input", "query must not be empty.");
  }

  if (query.length > BCN_RECOMMEND_QUERY_MAX_CHARS || /[\r\n]/u.test(query)) {
    throw new BcnError(
      "invalid_input",
      `query must be a single line no longer than ${BCN_RECOMMEND_QUERY_MAX_CHARS} characters.`,
    );
  }

  return {
    query,
    normalizedQuery: normalizeBcnGeoText(query),
    limit: normalizeLimit(input.limit, config.maxResults, 5),
    ...(input.task ? { task: normalizeTask(input.task) } : {}),
    ...(input.place_kind ? { place_kind: normalizePlaceKind(input.place_kind) } : {}),
  };
}

function normalizeTask(task: string): BcnResourceRecommendationTask {
  const normalized = task.trim().toLowerCase();

  if (!TASK_VALUES.has(normalized as BcnResourceRecommendationTask)) {
    throw new BcnError("invalid_input", `Unsupported BCN recommendation task: ${task}.`, {
      source_error: {
        allowed_tasks: [...TASK_VALUES],
      },
    });
  }

  return normalized as BcnResourceRecommendationTask;
}

function normalizePlaceKind(placeKind: string): BcnResourceRecommendationPlaceKind {
  const normalized = placeKind.trim().toLowerCase();

  if (!PLACE_KIND_VALUES.has(normalized as BcnResourceRecommendationPlaceKind)) {
    throw new BcnError(
      "invalid_input",
      `Unsupported BCN recommendation place_kind: ${placeKind}.`,
      {
        source_error: {
          allowed_place_kinds: [...PLACE_KIND_VALUES],
        },
      },
    );
  }

  return normalized as BcnResourceRecommendationPlaceKind;
}

function scoreRecommendation(
  recommendation: RegistryRecommendation,
  input: NormalizedRecommendResourcesInput,
): ScoredRecommendation {
  const matchedTerms = getMatchedTerms(recommendation, input.normalizedQuery);
  let score = matchedTerms.length * 15;

  if (input.task && recommendation.preferredTasks.includes(input.task)) {
    score += 25;
  }

  if (input.place_kind && recommendation.placeKinds.includes(input.place_kind)) {
    score += 20;
  }

  if (input.place_kind === "street" && recommendation.suggestedContainsFields) {
    score += 8;
  }

  if ((input.task === "group" || input.task === "count") && recommendation.suggestedGroupBy) {
    score += 10;
  }

  if ((input.task === "near" || input.task === "within") && recommendation.geoCapable) {
    score += 10;
  }

  if (input.task === "within" && recommendation.areaSource) {
    score += 10;
  }

  if (input.normalizedQuery.includes(normalizeBcnGeoText(recommendation.theme))) {
    score += 15;
  }

  return { recommendation, score, matchedTerms };
}

function getMatchedTerms(
  recommendation: RegistryRecommendation,
  normalizedQuery: string,
): string[] {
  // Both the query and registry keywords pass through normalizeBcnGeoText, which
  // strips Catalan/Spanish street prefixes ("carrer", "carrer de", "plaça",
  // "avinguda", etc.). Registry keywords made up of just those prefixes will
  // normalize to empty strings and never match — keep keyword entries to the
  // distinguishing tokens (e.g. "consell de cent", not "carrer").
  const queryTokens = new Set(
    normalizedQuery
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
  const matched = new Set<string>();

  for (const keyword of recommendation.keywords) {
    const normalizedKeyword = normalizeBcnGeoText(keyword);

    if (!normalizedKeyword) {
      continue;
    }

    if (normalizedQuery.includes(normalizedKeyword)) {
      matched.add(keyword);
      continue;
    }

    const keywordTokens = normalizedKeyword.split(" ").filter((token) => token.length >= 3);

    if (keywordTokens.some((token) => queryTokens.has(token))) {
      matched.add(keyword);
    }
  }

  return [...matched].slice(0, 8);
}

function compareScoredRecommendations(a: ScoredRecommendation, b: ScoredRecommendation): number {
  return (
    b.score - a.score ||
    b.matchedTerms.length - a.matchedTerms.length ||
    Number(b.recommendation.datastoreActive) - Number(a.recommendation.datastoreActive) ||
    a.recommendation.title.localeCompare(b.recommendation.title)
  );
}

function toPublicRecommendation(
  item: ScoredRecommendation,
  input: NormalizedRecommendResourcesInput,
): BcnResourceRecommendation {
  const recommendation = item.recommendation;

  return {
    title: recommendation.title,
    theme: recommendation.theme,
    description: recommendation.description,
    package_id: recommendation.packageId,
    resource_id: recommendation.resourceId,
    source_url: recommendation.sourceUrl,
    area_source: recommendation.areaSource ?? false,
    datastore_active: recommendation.datastoreActive,
    format: recommendation.format,
    geo_capable: recommendation.geoCapable,
    suggested_tool: getSuggestedTool(recommendation, input),
    suggested_fields: recommendation.suggestedFields,
    ...(recommendation.suggestedContainsFields
      ? { suggested_contains_fields: recommendation.suggestedContainsFields }
      : {}),
    ...(recommendation.suggestedGroupBy
      ? { suggested_group_by: recommendation.suggestedGroupBy }
      : {}),
    example_arguments: buildExampleArguments(recommendation, input),
    confidence: Math.min(0.99, Number((item.score / 100).toFixed(2))),
    matched_terms: item.matchedTerms,
    caveats: [
      ...(recommendation.caveats ?? []),
      ...(item.matchedTerms.length === 0
        ? ["No direct keyword match; verify this curated suggestion with bcn_get_resource_info."]
        : []),
    ],
  };
}

function getSuggestedTool(
  recommendation: RegistryRecommendation,
  input: NormalizedRecommendResourcesInput,
): BcnRecommendedTool {
  if (input.task === "preview") {
    return recommendation.datastoreActive ? "bcn_query_resource" : "bcn_preview_resource";
  }

  if (recommendation.areaSource) {
    return "bcn_resolve_place";
  }

  if (
    recommendation.geoCapable &&
    (input.task === "near" || input.task === "within" || input.place_kind)
  ) {
    return "bcn_query_resource_geo";
  }

  if (recommendation.geoCapable && (input.task === "count" || input.task === "group")) {
    return "bcn_query_resource_geo";
  }

  if (!recommendation.datastoreActive) {
    return "bcn_preview_resource";
  }

  return "bcn_query_resource";
}

function buildExampleArguments(
  recommendation: RegistryRecommendation,
  input: NormalizedRecommendResourcesInput,
): Record<string, JsonValue> {
  const fields = recommendation.suggestedFields.slice(0, 6);
  const suggestedTool = getSuggestedTool(recommendation, input);

  if (suggestedTool === "bcn_resolve_place") {
    return {
      query: `<${input.place_kind ?? recommendation.placeKinds[0] ?? "place"} name>`,
      kinds: recommendation.placeKinds,
      limit: 3,
    };
  }

  if (suggestedTool === "bcn_query_resource_geo") {
    return {
      resource_id: recommendation.resourceId,
      ...getExampleGeoNarrowing(recommendation, input),
      ...(fields.length > 0 ? { fields } : {}),
      ...getExampleGroupBy(recommendation, input),
      limit: 20,
    };
  }

  if (!recommendation.datastoreActive) {
    return {
      resource_id: recommendation.resourceId,
      limit: 20,
    };
  }

  return {
    resource_id: recommendation.resourceId,
    ...(fields.length > 0 ? { fields } : {}),
    limit: 20,
  };
}

function getExampleGeoNarrowing(
  recommendation: RegistryRecommendation,
  input: NormalizedRecommendResourcesInput,
): Record<string, JsonValue> {
  if (
    input.task === "within" ||
    input.place_kind === "district" ||
    input.place_kind === "neighborhood"
  ) {
    return {
      within_place: {
        source_resource_id: "<area_ref.source_resource_id from bcn_resolve_place>",
        row_id: "<area_ref.row_id from bcn_resolve_place>",
        geometry_field: "<area_ref.geometry_field from bcn_resolve_place>",
      },
    };
  }

  if (input.place_kind === "street" && recommendation.suggestedContainsFields?.[0]) {
    return {
      contains: {
        [recommendation.suggestedContainsFields[0]]: "<street name>",
      },
    };
  }

  return {
    near: {
      lat: 41.4036,
      lon: 2.1744,
      radius_m: 500,
    },
  };
}

function getExampleGroupBy(
  recommendation: RegistryRecommendation,
  input: NormalizedRecommendResourcesInput,
): Record<string, JsonValue> {
  if ((input.task === "group" || input.task === "count") && recommendation.suggestedGroupBy?.[0]) {
    return { group_by: recommendation.suggestedGroupBy[0] };
  }

  return {};
}

function capRecommendData(
  data: BcnRecommendResourcesData,
  provenance: BcnOperationProvenance,
  responseMaxBytes: number,
): BcnRecommendResourcesData {
  let cappedData = data;

  while (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    if (cappedData.recommendations.length === 0) {
      throw new BcnError(
        "invalid_response",
        "Open Data BCN recommendation response exceeds response cap even after dropping recommendations.",
      );
    }

    const recommendations = cappedData.recommendations.slice(0, -1);
    cappedData = {
      ...cappedData,
      recommendations,
      recommendation_count: recommendations.length,
      truncated: true,
    };
  }

  return cappedData;
}
