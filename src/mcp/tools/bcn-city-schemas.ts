import { z } from "zod";

import { jsonValueSchema } from "../schemas.js";

export const placeKindSchema = z.enum([
  "facility",
  "landmark",
  "street",
  "neighborhood",
  "district",
]);

export const recommendationTaskSchema = z.enum([
  "near",
  "within",
  "count",
  "group",
  "preview",
  "query",
]);

export const recommendationPlaceKindSchema = z.enum([
  "point",
  "street",
  "neighborhood",
  "district",
]);

export const citySpatialModeSchema = z.enum([
  "contains",
  "near",
  "none",
  "preview",
  "query",
  "within",
]);

export const cityStatusSchema = z.enum([
  "needs_place_selection",
  "needs_resource_selection",
  "ready",
  "unsupported",
]);

export const cityExecutionStatusSchema = z.enum(["blocked", "completed"]);

export const cityAnswerTypeSchema = z.enum([
  "blocked",
  "empty_result",
  "grouped_counts",
  "nearest_rows",
  "preview_sample",
  "row_sample",
]);

export const cityFinalToolSchema = z.enum([
  "bcn_preview_resource",
  "bcn_query_resource",
  "bcn_query_resource_geo",
]);

export const recommendedToolSchema = z.enum([
  "bcn_get_resource_info",
  "bcn_preview_resource",
  "bcn_query_resource",
  "bcn_query_resource_geo",
  "bcn_resolve_place",
]);

export const geoBboxSchema = z.object({
  min_lat: z.number().min(-90).max(90),
  min_lon: z.number().min(-180).max(180),
  max_lat: z.number().min(-90).max(90),
  max_lon: z.number().min(-180).max(180),
});

export const areaGeometryTypeSchema = z.enum(["polygon", "multipolygon"]);

export const areaRefSchema = z.object({
  source_resource_id: z.string(),
  source_package_id: z.string().optional(),
  row_id: z.union([z.string(), z.number()]),
  geometry_field: z.string(),
  geometry_type: areaGeometryTypeSchema,
});

export const placeCandidateSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  kind: placeKindSchema,
  score: z.number(),
  matched_fields: z.array(z.string()),
  area_ref: areaRefSchema.optional(),
  area_ref_unavailable_reason: z.string().optional(),
  address: z.string().optional(),
  bbox: geoBboxSchema.optional(),
  district: z.string().optional(),
  neighborhood: z.string().optional(),
  source_dataset_name: z.string().optional(),
  source_resource_id: z.string(),
  source_package_id: z.string().optional(),
  source_url: z.string().url(),
});

export const recommendationSchema = z.object({
  title: z.string(),
  theme: z.string(),
  description: z.string(),
  package_id: z.string(),
  resource_id: z.string(),
  source_url: z.string().url(),
  area_source: z.boolean(),
  datastore_active: z.boolean(),
  format: z.string(),
  geo_capable: z.boolean(),
  suggested_tool: recommendedToolSchema,
  suggested_fields: z.array(z.string()),
  suggested_contains_fields: z.array(z.string()).optional(),
  suggested_group_by: z.array(z.string()).optional(),
  example_arguments: z.record(jsonValueSchema),
  confidence: z.number().min(0).max(1),
  matched_terms: z.array(z.string()),
  caveats: z.array(z.string()),
});

export const cityIntentSchema = z.object({
  query: z.string(),
  normalized_query: z.string(),
  task: recommendationTaskSchema,
  spatial_mode: citySpatialModeSchema,
  place_kind: recommendationPlaceKindSchema.optional(),
  place_query: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  caveats: z.array(z.string()),
});

export const cityPlanStepSchema = z.object({
  order: z.number().int().min(1),
  tool: z.enum([
    "bcn_get_resource_info",
    "bcn_preview_resource",
    "bcn_query_resource",
    "bcn_query_resource_geo",
    "bcn_recommend_resources",
    "bcn_resolve_place",
  ]),
  arguments: z.record(jsonValueSchema),
  depends_on: z.array(z.string()).optional(),
  reason: z.string(),
  status: z.enum(["blocked", "completed", "planned"]),
});

export const cityResourceOverrideSchema = z.object({
  resource_id: z.string(),
  name: z.string(),
  package_id: z.string().nullable(),
  source_url: z.string().url(),
  datastore_active: z.boolean(),
  format: z.string().nullable(),
});

export const cityCitationSchema = z.object({
  resources: z.array(z.string()),
  prompts: z.array(z.string()),
  guidance: z.string(),
});

export const cityPlaceResolutionSchema = z.object({
  query: z.string(),
  candidate_count: z.number().int().nonnegative(),
  candidates: z.array(placeCandidateSchema),
  selected_candidate: placeCandidateSchema.optional(),
  truncated: z.boolean(),
});

export const cityPlanDataSchema = z.object({
  status: cityStatusSchema,
  intent: cityIntentSchema,
  recommendation: recommendationSchema.optional(),
  recommendations: z.array(recommendationSchema).optional(),
  resource_override: cityResourceOverrideSchema.optional(),
  place_resolution: cityPlaceResolutionSchema.optional(),
  steps: z.array(cityPlanStepSchema),
  final_tool: cityFinalToolSchema.optional(),
  final_arguments: z.record(jsonValueSchema).optional(),
  citation: cityCitationSchema,
});

export const cityAnswerSelectedResourceSchema = z.object({
  resource_id: z.string(),
  package_id: z.string().nullable(),
  source_url: z.string().url(),
  datastore_active: z.boolean(),
  format: z.string().nullable(),
  title: z.string(),
  theme: z.string().optional(),
});

export const cityAnswerSelectionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().optional(),
  theme: z.string().optional(),
  confidence: z.number(),
  provenance: z.record(jsonValueSchema),
  resume_arguments: z.record(jsonValueSchema),
});

export const cityAnswerSelectionOptionsSchema = z.object({
  selection_type: z.enum(["place", "resource"]),
  options: z.array(cityAnswerSelectionOptionSchema),
});

export const executeCityQueryDataSchema = z.object({
  plan: cityPlanDataSchema,
  execution_status: cityExecutionStatusSchema,
  final_tool: cityFinalToolSchema.optional(),
  final_arguments: z.record(jsonValueSchema).optional(),
  final_result: z.record(jsonValueSchema).nullable().optional(),
});

export const answerCityQueryDataSchema = z.object({
  answer_markdown: z.string(),
  answer_text: z.string(),
  answer_type: cityAnswerTypeSchema,
  summary: z.record(jsonValueSchema),
  caveats: z.array(z.string()),
  execution_notes: z.array(z.string()),
  selected_resource: cityAnswerSelectedResourceSchema.optional(),
  selection_options: cityAnswerSelectionOptionsSchema.optional(),
  citation: cityCitationSchema,
  execution_status: cityExecutionStatusSchema,
  final_tool: cityFinalToolSchema.optional(),
  final_arguments: z.record(jsonValueSchema).optional(),
  final_result: z.record(jsonValueSchema).nullable(),
  plan: cityPlanDataSchema,
});
