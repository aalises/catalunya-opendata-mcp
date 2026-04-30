import type { AppConfig } from "../../config.js";
import { type JsonValue, toJsonSafeValue } from "../common/json-safe.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeLimit,
} from "./catalog.js";
import { BcnError, type FetchBcnJsonOptions } from "./client.js";
import {
  BCN_GEO_RADIUS_DEFAULT_METERS,
  type BcnQueryResourceGeoInput,
  type BcnQueryResourceGeoResult,
  normalizeBcnGeoText,
  queryBcnResourceGeo,
} from "./geo.js";
import {
  type BcnPlaceKind,
  type BcnResolvedPlaceCandidate,
  type BcnResolvePlaceData,
  resolveBcnPlace,
} from "./place.js";
import { type BcnPreviewResourceResult, previewBcnResource } from "./preview.js";
import { type BcnQueryResourceResult, queryBcnResource } from "./query.js";
import {
  type BcnRecommendedTool,
  type BcnResourceRecommendation,
  type BcnResourceRecommendationPlaceKind,
  type BcnResourceRecommendationTask,
  recommendBcnResources,
} from "./recommend.js";
import { type BcnResourceInfoData, getBcnResourceInfo } from "./resource.js";

export const BCN_CITY_QUERY_MAX_CHARS = 240;
export const BCN_CITY_PLACE_LIMIT_DEFAULT = 3;
export const BCN_CITY_RESULT_LIMIT_DEFAULT = 10;

export type BcnCityQueryStatus =
  | "needs_place_selection"
  | "needs_resource_selection"
  | "ready"
  | "unsupported";
export type BcnCityQueryExecutionStatus = "blocked" | "completed";
export type BcnCityIntentConfidence = "high" | "low" | "medium";
export type BcnCitySpatialMode = "contains" | "near" | "none" | "preview" | "query" | "within";
export type BcnCityPlanStepStatus = "blocked" | "completed" | "planned";
export type BcnCityFinalTool =
  | "bcn_preview_resource"
  | "bcn_query_resource"
  | "bcn_query_resource_geo";

export interface BcnCityQueryInput {
  fields?: string[];
  filters?: Record<string, unknown>;
  group_by?: string;
  limit?: number;
  place_kind?: string;
  place_query?: string;
  query: string;
  radius_m?: number;
  resource_id?: string;
  task?: string;
}

export interface BcnCityQueryIntent {
  caveats: string[];
  confidence: BcnCityIntentConfidence;
  normalized_query: string;
  place_kind?: BcnResourceRecommendationPlaceKind;
  place_query?: string;
  query: string;
  spatial_mode: BcnCitySpatialMode;
  task: BcnResourceRecommendationTask;
}

export interface BcnCityPlanStep {
  arguments: Record<string, JsonValue>;
  depends_on?: string[];
  order: number;
  reason: string;
  status: BcnCityPlanStepStatus;
  tool: BcnRecommendedTool | BcnCityFinalTool | "bcn_recommend_resources";
}

export interface BcnCityResourceOverride {
  datastore_active: boolean;
  format: string | null;
  name: string;
  package_id: string | null;
  resource_id: string;
  source_url: string;
}

export interface BcnCityPlaceResolution {
  candidate_count: number;
  candidates: BcnResolvedPlaceCandidate[];
  query: string;
  selected_candidate?: BcnResolvedPlaceCandidate;
  truncated: boolean;
}

export interface BcnCityCitationGuidance {
  guidance: string;
  prompts: string[];
  resources: string[];
}

export interface BcnCityPlanData {
  citation: BcnCityCitationGuidance;
  final_arguments?: Record<string, JsonValue>;
  final_tool?: BcnCityFinalTool;
  intent: BcnCityQueryIntent;
  place_resolution?: BcnCityPlaceResolution;
  recommendation?: BcnResourceRecommendation;
  recommendations?: BcnResourceRecommendation[];
  resource_override?: BcnCityResourceOverride;
  status: BcnCityQueryStatus;
  steps: BcnCityPlanStep[];
}

export interface BcnCityPlanQueryResult {
  data: BcnCityPlanData;
  provenance: BcnOperationProvenance;
}

export interface BcnCityExecuteQueryData {
  execution_status: BcnCityQueryExecutionStatus;
  final_arguments?: Record<string, JsonValue>;
  final_result?: Record<string, JsonValue>;
  final_tool?: BcnCityFinalTool;
  plan: BcnCityPlanData;
}

export interface BcnCityExecuteQueryResult {
  data: BcnCityExecuteQueryData;
  provenance: BcnOperationProvenance;
}

interface NormalizedCityQueryInput {
  fields?: string[];
  filters?: Record<string, JsonValue>;
  group_by?: string;
  limit: number;
  place_kind?: BcnResourceRecommendationPlaceKind;
  place_query?: string;
  query: string;
  radius_m?: number;
  resource_id?: string;
  task?: BcnResourceRecommendationTask;
}

interface ResolvedPlanResource {
  recommendation?: BcnResourceRecommendation;
  recommendations?: BcnResourceRecommendation[];
  resourceOverride?: BcnCityResourceOverride;
}

export async function planBcnCityQuery(
  input: BcnCityQueryInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnCityPlanQueryResult> {
  const normalized = normalizeCityQueryInput(input, config);
  const intent = inferCityQueryIntent(normalized);
  const resource = await resolvePlanResource(normalized, intent, config, options);
  const steps: BcnCityPlanStep[] = [];

  if (!resource.recommendation && !resource.resourceOverride) {
    const status: BcnCityQueryStatus =
      resource.recommendations && resource.recommendations.length > 0
        ? "needs_resource_selection"
        : "unsupported";

    return {
      data: {
        citation: createCitationGuidance(resource),
        intent,
        ...(resource.recommendations ? { recommendations: resource.recommendations } : {}),
        status,
        steps,
      },
      provenance: createBcnOperationProvenance("city_query_plan"),
    };
  }

  addResourceStep(steps, normalized, intent, resource);

  const placeResolution = await maybeResolvePlanPlace(normalized, intent, config, options);
  if (placeResolution) {
    steps.push({
      order: steps.length + 1,
      tool: "bcn_resolve_place",
      arguments: {
        query: placeResolution.query,
        limit: BCN_CITY_PLACE_LIMIT_DEFAULT,
        ...getResolvePlaceKindsArgument(intent),
      },
      reason: "Resolve the named Barcelona place before building the final geo query.",
      status: "completed",
    });

    if (!placeResolution.selected_candidate) {
      const status =
        placeResolution.candidate_count > 0 ? "needs_place_selection" : "needs_place_selection";

      return {
        data: {
          citation: createCitationGuidance(resource),
          intent,
          place_resolution: placeResolution,
          ...(resource.recommendation ? { recommendation: resource.recommendation } : {}),
          ...(resource.recommendations ? { recommendations: resource.recommendations } : {}),
          ...(resource.resourceOverride ? { resource_override: resource.resourceOverride } : {}),
          status,
          steps: [
            ...steps,
            {
              order: steps.length + 1,
              tool: "bcn_query_resource_geo",
              arguments: {},
              reason: "A single place candidate is required before executing the final geo query.",
              status: "blocked",
            },
          ],
        },
        provenance: createBcnOperationProvenance("city_query_plan"),
      };
    }
  }

  const final = buildFinalQuery(normalized, intent, resource, placeResolution?.selected_candidate);

  if (!final) {
    return {
      data: {
        citation: createCitationGuidance(resource),
        intent: {
          ...intent,
          caveats: [
            ...intent.caveats,
            "The planner could not derive safe final arguments for this city question.",
          ],
        },
        place_resolution: placeResolution,
        ...(resource.recommendation ? { recommendation: resource.recommendation } : {}),
        ...(resource.recommendations ? { recommendations: resource.recommendations } : {}),
        ...(resource.resourceOverride ? { resource_override: resource.resourceOverride } : {}),
        status: "unsupported",
        steps,
      },
      provenance: createBcnOperationProvenance("city_query_plan"),
    };
  }

  steps.push({
    order: steps.length + 1,
    tool: final.tool,
    arguments: final.arguments,
    depends_on: placeResolution ? ["bcn_resolve_place"] : undefined,
    reason: final.reason,
    status: "planned",
  });

  return {
    data: {
      citation: createCitationGuidance(resource),
      final_arguments: final.arguments,
      final_tool: final.tool,
      intent,
      ...(placeResolution ? { place_resolution: placeResolution } : {}),
      ...(resource.recommendation ? { recommendation: resource.recommendation } : {}),
      ...(resource.recommendations ? { recommendations: resource.recommendations } : {}),
      ...(resource.resourceOverride ? { resource_override: resource.resourceOverride } : {}),
      status: "ready",
      steps,
    },
    provenance: createBcnOperationProvenance("city_query_plan"),
  };
}

export async function executeBcnCityQuery(
  input: BcnCityQueryInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnCityExecuteQueryResult> {
  const plan = await planBcnCityQuery(input, config, options);
  const provenance = createBcnOperationProvenance("city_query_execute");

  if (plan.data.status !== "ready" || !plan.data.final_tool || !plan.data.final_arguments) {
    return {
      data: {
        execution_status: "blocked",
        plan: plan.data,
      },
      provenance,
    };
  }

  const finalResult = await executeFinalTool(
    plan.data.final_tool,
    plan.data.final_arguments,
    config,
    options,
  );

  return {
    data: {
      execution_status: "completed",
      final_arguments: plan.data.final_arguments,
      final_result: (toJsonSafeValue(finalResult) ?? null) as Record<string, JsonValue>,
      final_tool: plan.data.final_tool,
      plan: plan.data,
    },
    provenance,
  };
}

function normalizeCityQueryInput(
  input: BcnCityQueryInput,
  config: AppConfig,
): NormalizedCityQueryInput {
  const query = input.query.trim();

  if (!query || /[\r\n]/u.test(query) || query.length > BCN_CITY_QUERY_MAX_CHARS) {
    throw new BcnError(
      "invalid_input",
      `query must be a single line between 1 and ${BCN_CITY_QUERY_MAX_CHARS} characters.`,
    );
  }

  return {
    query,
    ...(input.task === undefined ? {} : { task: normalizeTask(input.task) }),
    ...(input.place_kind === undefined ? {} : { place_kind: normalizePlaceKind(input.place_kind) }),
    ...(input.place_query?.trim() ? { place_query: input.place_query.trim() } : {}),
    ...(input.resource_id?.trim() ? { resource_id: input.resource_id.trim() } : {}),
    ...(input.fields && input.fields.length > 0 ? { fields: normalizeFields(input.fields) } : {}),
    ...(input.filters === undefined ? {} : { filters: normalizeJsonRecord(input.filters) }),
    ...(input.group_by?.trim() ? { group_by: input.group_by.trim() } : {}),
    ...(input.radius_m === undefined ? {} : { radius_m: normalizeRadius(input.radius_m) }),
    limit: normalizeLimit(input.limit, config.maxResults, BCN_CITY_RESULT_LIMIT_DEFAULT),
  };
}

function inferCityQueryIntent(input: NormalizedCityQueryInput): BcnCityQueryIntent {
  const normalizedQuery = normalizeBcnGeoText(input.query);
  const explicitTask = input.task;
  const spatialMode = inferSpatialMode(input, normalizedQuery);
  const task = explicitTask ?? inferTask(normalizedQuery, spatialMode);
  const placeKind = input.place_kind ?? inferPlaceKind(normalizedQuery, spatialMode);
  const placeQuery = input.place_query ?? inferPlaceQuery(input.query, spatialMode);
  const caveats: string[] = [];

  if (!input.place_query && placeQuery) {
    caveats.push("Place query was inferred deterministically from the question text.");
  }

  return {
    caveats,
    confidence: getIntentConfidence(input, spatialMode, placeQuery),
    normalized_query: normalizedQuery,
    ...(placeKind ? { place_kind: placeKind } : {}),
    ...(placeQuery ? { place_query: placeQuery } : {}),
    query: input.query,
    spatial_mode: spatialMode,
    task,
  };
}

async function resolvePlanResource(
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<ResolvedPlanResource> {
  if (input.resource_id) {
    const info = await getBcnResourceInfo({ resource_id: input.resource_id }, config, options);
    return { resourceOverride: toResourceOverride(info.data) };
  }

  const recommendationResult = recommendBcnResources(
    {
      query: input.query,
      task: getRecommendationTask(intent),
      ...(intent.place_kind ? { place_kind: intent.place_kind } : {}),
      limit: 3,
    },
    config,
  );
  const recommendations = recommendationResult.data.recommendations.filter(
    (candidate) => candidate.matched_terms.length > 0 || candidate.confidence >= 0.5,
  );
  const recommendation = recommendations.find((candidate) => !candidate.area_source);

  return {
    recommendation,
    recommendations,
  };
}

async function maybeResolvePlanPlace(
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<BcnCityPlaceResolution | undefined> {
  if (!intent.place_query || (intent.spatial_mode !== "near" && intent.spatial_mode !== "within")) {
    return undefined;
  }

  const placeResult = await resolveBcnPlace(
    {
      query: intent.place_query,
      limit: BCN_CITY_PLACE_LIMIT_DEFAULT,
      ...getResolvePlaceKindsArgument(intent),
    },
    config,
    options,
  );
  const selected = selectPlaceCandidate(placeResult.data, intent, input.place_kind !== undefined);

  return {
    candidate_count: placeResult.data.candidate_count,
    candidates: placeResult.data.candidates,
    query: placeResult.data.query,
    ...(selected ? { selected_candidate: selected } : {}),
    truncated: placeResult.data.truncated,
  };
}

function buildFinalQuery(
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  resource: ResolvedPlanResource,
  place?: BcnResolvedPlaceCandidate,
): { arguments: Record<string, JsonValue>; reason: string; tool: BcnCityFinalTool } | undefined {
  const resourceId = resource.recommendation?.resource_id ?? resource.resourceOverride?.resource_id;

  if (!resourceId) {
    return undefined;
  }

  if (intent.spatial_mode === "preview") {
    if (resource.resourceOverride?.datastore_active || resource.recommendation?.datastore_active) {
      return {
        arguments: buildQueryArguments(resourceId, input),
        reason:
          "Preview requested for a DataStore-active resource, so use a bounded DataStore query.",
        tool: "bcn_query_resource",
      };
    }

    return {
      arguments: { resource_id: resourceId, limit: input.limit },
      reason:
        "Preview requested for a non-DataStore resource, so use the bounded download preview.",
      tool: "bcn_preview_resource",
    };
  }

  if (intent.spatial_mode === "query") {
    return {
      arguments: buildQueryArguments(resourceId, input),
      reason: "The question is a bounded tabular query over the selected resource.",
      tool: "bcn_query_resource",
    };
  }

  const geoArguments = buildGeoArguments(resourceId, input, intent, resource.recommendation, place);

  if (!geoArguments) {
    return undefined;
  }

  return {
    arguments: geoArguments,
    reason: "The final step runs one bounded geospatial query with structured arguments.",
    tool: "bcn_query_resource_geo",
  };
}

async function executeFinalTool(
  tool: BcnCityFinalTool,
  args: Record<string, JsonValue>,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<BcnPreviewResourceResult | BcnQueryResourceGeoResult | BcnQueryResourceResult> {
  if (tool === "bcn_preview_resource") {
    return previewBcnResource(
      { resource_id: String(args.resource_id), limit: getNumberArg(args.limit) },
      config,
      options,
    );
  }

  if (tool === "bcn_query_resource") {
    return queryBcnResource(
      {
        resource_id: String(args.resource_id),
        fields: getStringArrayArg(args.fields),
        filters: getRecordArg(args.filters),
        limit: getNumberArg(args.limit),
      },
      config,
      options,
    );
  }

  return queryBcnResourceGeo(args as unknown as BcnQueryResourceGeoInput, config, options);
}

function buildGeoArguments(
  resourceId: string,
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  recommendation: BcnResourceRecommendation | undefined,
  place: BcnResolvedPlaceCandidate | undefined,
): Record<string, JsonValue> | undefined {
  const fields = input.fields ?? recommendation?.suggested_fields?.slice(0, 6);
  const groupBy = input.group_by ?? getDefaultGroupBy(input, intent, recommendation);
  const base = {
    resource_id: resourceId,
    ...(fields && fields.length > 0 ? { fields } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
    ...(groupBy ? { group_by: groupBy } : {}),
    limit: input.limit,
  } satisfies Record<string, JsonValue>;

  if (intent.spatial_mode === "contains") {
    const field = recommendation?.suggested_contains_fields?.[0];

    if (!field || !intent.place_query) {
      return undefined;
    }

    return {
      ...base,
      contains: {
        [field]: intent.place_query,
      },
    };
  }

  if (intent.spatial_mode === "near") {
    if (!place) {
      return undefined;
    }

    return {
      ...base,
      near: {
        lat: place.lat,
        lon: place.lon,
        radius_m: input.radius_m ?? BCN_GEO_RADIUS_DEFAULT_METERS,
      },
    };
  }

  if (intent.spatial_mode === "within") {
    if (!place) {
      return undefined;
    }

    if (place.area_ref) {
      return {
        ...base,
        within_place: {
          source_resource_id: place.area_ref.source_resource_id,
          row_id: place.area_ref.row_id,
          geometry_field: place.area_ref.geometry_field,
        },
      };
    }

    if (place.bbox) {
      const bbox = place.bbox;

      return {
        ...base,
        bbox: {
          max_lat: bbox.max_lat,
          max_lon: bbox.max_lon,
          min_lat: bbox.min_lat,
          min_lon: bbox.min_lon,
        },
      };
    }
  }

  return undefined;
}

function buildQueryArguments(
  resourceId: string,
  input: NormalizedCityQueryInput,
): Record<string, JsonValue> {
  return {
    resource_id: resourceId,
    ...(input.fields ? { fields: input.fields } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
    limit: input.limit,
  };
}

function inferSpatialMode(
  input: NormalizedCityQueryInput,
  normalizedQuery: string,
): BcnCitySpatialMode {
  if (input.task === "preview") {
    return "preview";
  }

  if (/\b(near|around|close to|prop de|a prop de|cerca de)\b/u.test(normalizedQuery)) {
    return "near";
  }

  if (
    /\b(in|inside|within|district|districts|neighborhood|neighbourhood|barri|barris|districte|districtes|barrio|barrios|distrito|distritos)\b/u.test(
      normalizedQuery,
    )
  ) {
    return "within";
  }

  if (/\b(on|street|carrer|calle)\b/u.test(normalizedQuery)) {
    return "contains";
  }

  if (input.task === "query") {
    return "query";
  }

  return "query";
}

function inferTask(
  normalizedQuery: string,
  spatialMode: BcnCitySpatialMode,
): BcnResourceRecommendationTask {
  if (spatialMode === "preview") {
    return "preview";
  }

  if (
    /\b(count|counts|by|group|species|type|category|categoria|categories)\b/u.test(normalizedQuery)
  ) {
    return "group";
  }

  if (spatialMode === "near") {
    return "near";
  }

  if (spatialMode === "within") {
    return "within";
  }

  return "query";
}

function inferPlaceKind(
  normalizedQuery: string,
  spatialMode: BcnCitySpatialMode,
): BcnResourceRecommendationPlaceKind | undefined {
  if (/\bby (neighborhood|neighbourhood|barri|barrio)\b/u.test(normalizedQuery)) {
    return "district";
  }

  if (/\b(district|districts|districte|districtes|distrito|distritos)\b/u.test(normalizedQuery)) {
    return "district";
  }

  if (
    /\b(neighborhood|neighbourhood|neighborhoods|neighbourhoods|barri|barris|barrio|barrios)\b/u.test(
      normalizedQuery,
    )
  ) {
    return "neighborhood";
  }

  if (spatialMode === "contains" || /\b(street|carrer|calle)\b/u.test(normalizedQuery)) {
    return "street";
  }

  if (spatialMode === "near") {
    return "point";
  }

  return undefined;
}

function inferPlaceQuery(query: string, spatialMode: BcnCitySpatialMode): string | undefined {
  const patterns =
    spatialMode === "near"
      ? [/\b(?:near|around|close to|prop de|a prop de|cerca de)\s+(.+)$/iu]
      : spatialMode === "within"
        ? [/\b(?:in|inside|within|en)\s+(.+)$/iu]
        : spatialMode === "contains"
          ? [/\b(?:on|street|carrer|calle)\s+(.+)$/iu]
          : [];

  for (const pattern of patterns) {
    const match = pattern.exec(query);

    if (match?.[1]) {
      return cleanupPlaceQuery(match[1], spatialMode);
    }
  }

  if (spatialMode === "contains") {
    const carrerMatch = /\b(carrer\s+.+)$/iu.exec(query);

    if (carrerMatch?.[1]) {
      return cleanupPlaceQuery(carrerMatch[1], spatialMode);
    }
  }

  return undefined;
}

function cleanupPlaceQuery(value: string, spatialMode: BcnCitySpatialMode): string {
  let cleaned = value
    .replace(/[?.!,;:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (spatialMode === "within") {
    cleaned = cleaned
      .replace(/\s+\bby\b.+$/iu, "")
      .replace(/\s+\b(grouped by|group by)\b.+$/iu, "")
      .replace(
        /\s+\b(district|districts|districte|districtes|distrito|distritos|neighborhood|neighbourhood|barri|barris|barrio|barrios)\b$/iu,
        "",
      )
      .trim();
  }

  return cleaned;
}

function getResolvePlaceKindsArgument(intent: BcnCityQueryIntent): { kinds?: BcnPlaceKind[] } {
  if (intent.place_kind === "district") {
    return { kinds: ["district"] };
  }

  if (intent.place_kind === "neighborhood") {
    return { kinds: ["neighborhood"] };
  }

  if (intent.place_kind === "street") {
    return { kinds: ["street"] };
  }

  if (intent.spatial_mode === "near") {
    // City-query "point" maps to resolver point-like sources only; street
    // candidates are intentionally excluded unless place_kind is street.
    return { kinds: ["landmark", "facility"] };
  }

  if (intent.spatial_mode === "within") {
    return { kinds: ["district", "neighborhood"] };
  }

  return {};
}

function selectPlaceCandidate(
  data: BcnResolvePlaceData,
  intent: BcnCityQueryIntent,
  hasExplicitPlaceKind: boolean,
): BcnResolvedPlaceCandidate | undefined {
  if (data.candidates.length === 0) {
    return undefined;
  }

  if (!hasExplicitPlaceKind) {
    const [first, second] = data.candidates;

    if (
      first &&
      second &&
      first.kind !== second.kind &&
      intent.spatial_mode === "within" &&
      Math.abs(first.score - second.score) < 5
    ) {
      return undefined;
    }
  }

  return data.candidates[0];
}

function addResourceStep(
  steps: BcnCityPlanStep[],
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  resource: ResolvedPlanResource,
): void {
  if (resource.resourceOverride) {
    steps.push({
      order: steps.length + 1,
      tool: "bcn_get_resource_info",
      arguments: { resource_id: resource.resourceOverride.resource_id },
      reason: "Use the caller-provided BCN resource and inspect its metadata.",
      status: "completed",
    });
    return;
  }

  steps.push({
    order: steps.length + 1,
    tool: "bcn_recommend_resources",
    arguments: {
      query: input.query,
      task: getRecommendationTask(intent),
      ...(intent.place_kind ? { place_kind: intent.place_kind } : {}),
      limit: 3,
    },
    reason: "Choose a high-value source-bounded BCN resource for the city question.",
    status: "completed",
  });
}

function getRecommendationTask(intent: BcnCityQueryIntent): BcnResourceRecommendationTask {
  if (intent.spatial_mode === "within" && intent.task === "group") {
    return "within";
  }

  return intent.task;
}

function getDefaultGroupBy(
  input: NormalizedCityQueryInput,
  intent: BcnCityQueryIntent,
  recommendation: BcnResourceRecommendation | undefined,
): string | undefined {
  if (input.group_by) {
    return input.group_by;
  }

  if (intent.task !== "group" && intent.task !== "count") {
    return undefined;
  }

  if (intent.spatial_mode === "within") {
    return (
      recommendation?.suggested_group_by?.find((field) =>
        /neighborhood|barri/u.test(normalizeBcnGeoText(field)),
      ) ?? recommendation?.suggested_group_by?.[0]
    );
  }

  return recommendation?.suggested_group_by?.[0];
}

function createCitationGuidance(resource: ResolvedPlanResource): BcnCityCitationGuidance {
  const packageId = resource.recommendation?.package_id ?? resource.resourceOverride?.package_id;
  const resourceId = resource.recommendation?.resource_id ?? resource.resourceOverride?.resource_id;

  return {
    guidance:
      "Cite the selected Open Data BCN package/resource title, provenance.source_url, last_updated, and license_or_terms when available.",
    prompts: ["bcn_citation"],
    resources: [
      ...(packageId ? [`bcn://packages/${packageId}`] : []),
      ...(resourceId ? [`bcn://resources/${resourceId}/schema`] : []),
    ],
  };
}

function toResourceOverride(info: BcnResourceInfoData): BcnCityResourceOverride {
  return {
    datastore_active: info.datastore_active,
    format: info.format,
    name: info.name,
    package_id: info.package_id,
    resource_id: info.resource_id,
    source_url: info.provenance.source_url,
  };
}

function normalizeTask(value: string): BcnResourceRecommendationTask {
  if (
    value === "near" ||
    value === "within" ||
    value === "count" ||
    value === "group" ||
    value === "preview" ||
    value === "query"
  ) {
    return value;
  }

  throw new BcnError("invalid_input", `Unsupported BCN city query task ${JSON.stringify(value)}.`);
}

function normalizePlaceKind(value: string): BcnResourceRecommendationPlaceKind {
  if (value === "point" || value === "street" || value === "neighborhood" || value === "district") {
    return value;
  }

  throw new BcnError(
    "invalid_input",
    `Unsupported BCN city query place_kind ${JSON.stringify(value)}.`,
  );
}

function normalizeFields(fields: string[]): string[] {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);

  if (normalized.length === 0) {
    throw new BcnError("invalid_input", "fields must include at least one non-empty field name.");
  }

  return normalized;
}

function normalizeRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 5_000) {
    throw new BcnError("invalid_input", "radius_m must be greater than 0 and at most 5000.");
  }

  return radius;
}

function normalizeJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const normalized = toJsonSafeValue(value);

  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new BcnError("invalid_input", "filters must be a JSON object.");
  }

  return normalized as Record<string, JsonValue>;
}

function getNumberArg(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getStringArrayArg(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function getRecordArg(value: JsonValue | undefined): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getIntentConfidence(
  input: NormalizedCityQueryInput,
  spatialMode: BcnCitySpatialMode,
  placeQuery: string | undefined,
): BcnCityIntentConfidence {
  if (input.task && input.place_kind && (input.place_query || spatialMode === "query")) {
    return "high";
  }

  if (
    (spatialMode === "near" || spatialMode === "within" || spatialMode === "contains") &&
    placeQuery
  ) {
    return "medium";
  }

  return "low";
}
