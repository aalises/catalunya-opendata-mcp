import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  createBcnOperationProvenance,
  getBcnPackage,
  normalizeBcnId,
  searchBcnPackages,
} from "../../sources/bcn/catalog.js";
import { answerBcnCityQuery } from "../../sources/bcn/city-answer.js";
import { executeBcnCityQuery, planBcnCityQuery } from "../../sources/bcn/city-query.js";
import { BcnError, isBcnError } from "../../sources/bcn/client.js";
import { queryBcnResourceGeo } from "../../sources/bcn/geo.js";
import { resolveBcnPlace } from "../../sources/bcn/place.js";
import { previewBcnResource } from "../../sources/bcn/preview.js";
import { queryBcnResource } from "../../sources/bcn/query.js";
import { recommendBcnResources } from "../../sources/bcn/recommend.js";
import { getBcnResourceInfo } from "../../sources/bcn/resource.js";
import { createJsonTextContent } from "../../sources/common/caps.js";
import { toJsonSafeValue } from "../../sources/common/json-safe.js";
import { jsonValueSchema } from "../schemas.js";
import {
  answerCityQueryDataSchema,
  areaGeometryTypeSchema,
  cityPlanDataSchema,
  executeCityQueryDataSchema,
  geoBboxSchema,
  placeCandidateSchema,
  placeKindSchema,
  recommendationPlaceKindSchema,
  recommendationSchema,
  recommendationTaskSchema,
} from "./bcn-city-schemas.js";

export function registerBcnTools(server: McpServer, config: AppConfig, logger: Logger): void {
  const schemas = createBcnSchemas(config);

  server.registerTool(
    "bcn_search_packages",
    {
      title: "bcn.search_packages",
      description:
        "Discover Open Data BCN CKAN packages for Barcelona city datasets such as street trees, facilities, mobility, equipment, and services.",
      inputSchema: schemas.inputs.searchPackages,
      outputSchema: schemas.outputs.searchPackages,
    },
    async (input, extra) =>
      wrapBcnTool("package_search", async () =>
        searchBcnPackages(input, config, {
          logger: logger.child({ op: "package_search" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_get_package",
    {
      title: "bcn.get_package",
      description:
        "Fetch one Open Data BCN package, including resource IDs, formats, DataStore activity, package license, and provenance.",
      inputSchema: schemas.inputs.getPackage,
      outputSchema: schemas.outputs.getPackage,
    },
    async (input, extra) =>
      wrapBcnTool("package_show", async () =>
        getBcnPackage(input, config, {
          logger: logger.child({ op: "package_show" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_get_resource_info",
    {
      title: "bcn.get_resource_info",
      description:
        "Inspect one Open Data BCN resource. Active DataStore resources include queryable fields; inactive resources should use bcn_preview_resource.",
      inputSchema: schemas.inputs.getResourceInfo,
      outputSchema: schemas.outputs.getResourceInfo,
    },
    async (input, extra) =>
      wrapBcnTool("resource_show", async () =>
        getBcnResourceInfo(input, config, {
          logger: logger.child({ op: "resource_show" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_query_resource",
    {
      title: "bcn.query_resource",
      description: [
        "Query rows from an active Open Data BCN CKAN DataStore resource.",
        "Call bcn_get_resource_info first when possible and use returned field IDs.",
        "Pass filters as a JSON object, not raw SQL or URL query fragments.",
        "This always uses POST JSON to datastore_search and returns a bounded page with explicit truncation.",
        "If the resource is not DataStore-active, use bcn_preview_resource for a bounded CSV/JSON download preview.",
      ].join(" "),
      inputSchema: schemas.inputs.queryResource,
      outputSchema: schemas.outputs.queryResource,
    },
    async (input, extra) =>
      wrapBcnTool("datastore_search", async () =>
        queryBcnResource(input, config, {
          logger: logger.child({ op: "datastore_search" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_resolve_place",
    {
      title: "bcn.resolve_place",
      description: [
        "Resolve a Barcelona place name to candidate WGS84 coordinates using only source-bounded Open Data BCN DataStore resources.",
        "Use this before bcn_query_resource_geo when the user gives a named place instead of lat/lon.",
        "Supports optional bbox and kind filters for facilities, landmarks, streets, neighborhoods, and districts.",
      ].join(" "),
      inputSchema: schemas.inputs.resolvePlace,
      outputSchema: schemas.outputs.resolvePlace,
    },
    async (input, extra) =>
      wrapBcnTool("place_resolve", async () =>
        resolveBcnPlace(input, config, {
          logger: logger.child({ op: "place_resolve" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_recommend_resources",
    {
      title: "bcn.recommend_resources",
      description: [
        "Recommend high-value Open Data BCN resources for a natural-language city question.",
        "Use this before package search when the user asks broad questions such as trees on a street, facilities near a place, parks in an area, or district/neighborhood boundaries.",
        "The recommender is deterministic and source-bounded; follow up with bcn_get_resource_info, bcn_resolve_place, or bcn_query_resource_geo.",
      ].join(" "),
      inputSchema: schemas.inputs.recommendResources,
      outputSchema: schemas.outputs.recommendResources,
    },
    async (input) =>
      wrapBcnTool("resource_recommend", async () => recommendBcnResources(input, config)),
  );

  server.registerTool(
    "bcn_query_resource_geo",
    {
      title: "bcn.query_resource_geo",
      description: [
        "Run a bounded geospatial query over an Open Data BCN resource with WGS84 latitude/longitude columns.",
        "Works for DataStore-active resources and safe BCN-hosted CSV/JSON downloads; active near/bbox calls use generated CKAN SQL internally.",
        "Use near for distance queries, bbox for rectangular areas, within_place for district/neighborhood polygons returned by bcn_resolve_place.area_ref, contains for street/name text filters, and group_by for counts such as species by street.",
        "Coordinate fields are inferred from common BCN names such as latitud/longitud, geo_epgs_4326_lat/geo_epgs_4326_lon, and geo_epgs_4326_y/geo_epgs_4326_x; pass lat_field/lon_field when ambiguous.",
      ].join(" "),
      inputSchema: schemas.inputs.queryResourceGeo,
      outputSchema: schemas.outputs.queryResourceGeo,
    },
    async (input, extra) =>
      wrapBcnTool("resource_geo_query", async () =>
        queryBcnResourceGeo(input, config, {
          logger: logger.child({ op: "resource_geo_query" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_plan_query",
    {
      title: "bcn.plan_query",
      description: [
        "Plan a natural-language Barcelona city question into an explainable Open Data BCN workflow.",
        "Returns recommended resources, optional source-bounded place resolution, final tool arguments, and citation guidance without running the final data query.",
      ].join(" "),
      inputSchema: schemas.inputs.cityQuery,
      outputSchema: schemas.outputs.planQuery,
    },
    async (input, extra) =>
      wrapBcnTool("city_query_plan", async () =>
        planBcnCityQuery(input, config, {
          logger: logger.child({ op: "city_query_plan" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_execute_city_query",
    {
      title: "bcn.execute_city_query",
      description: [
        "Execute a safe bounded Open Data BCN city-question plan end-to-end.",
        "Blocks instead of guessing when the planner needs a resource or place selection.",
      ].join(" "),
      inputSchema: schemas.inputs.cityQuery,
      outputSchema: schemas.outputs.executeCityQuery,
    },
    async (input, extra) =>
      wrapBcnTool("city_query_execute", async () =>
        executeBcnCityQuery(input, config, {
          logger: logger.child({ op: "city_query_execute" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_answer_city_query",
    {
      title: "bcn.answer_city_query",
      description: [
        "Execute a safe bounded Open Data BCN city-question plan and compose a deterministic caller-ready answer.",
        "Returns answer_text, answer_markdown, blocked selection_options, map-ready summary points, caveats, execution_notes, selected resource metadata, citation guidance, and the raw final_result.",
      ].join(" "),
      inputSchema: schemas.inputs.cityQuery,
      outputSchema: schemas.outputs.answerCityQuery,
    },
    async (input, extra) =>
      wrapBcnTool("city_query_answer", async () =>
        answerBcnCityQuery(input, config, {
          logger: logger.child({ op: "city_query_answer" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "bcn_preview_resource",
    {
      title: "bcn.preview_resource",
      description:
        "Fetch a safe, bounded CSV or JSON preview for an Open Data BCN non-DataStore resource. Only HTTPS BCN-hosted download URLs and validated redirects are followed.",
      inputSchema: schemas.inputs.previewResource,
      outputSchema: schemas.outputs.previewResource,
    },
    async (input, extra) =>
      wrapBcnTool("resource_preview", async () =>
        previewBcnResource(input, config, {
          logger: logger.child({ op: "resource_preview" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerPrompt(
    "bcn_query_workflow",
    {
      title: "bcn.query_workflow",
      description: "Guide a user through finding and querying Open Data BCN resources.",
    },
    () => ({
      description: "Open Data BCN package, resource, query, and preview workflow guidance.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use this workflow for Barcelona city Open Data BCN questions.",
              "",
              "1. For broad city questions, start with `bcn_recommend_resources` to pick likely resources and example arguments. Use `bcn_search_packages` when the recommender is too narrow or the topic is not covered.",
              "1a. For natural city questions where you want the server to stitch the workflow together, call `bcn_plan_query` for an inspectable workflow, `bcn_execute_city_query` for raw bounded execution, or `bcn_answer_city_query` for deterministic answer_text plus raw final_result. These tools block instead of guessing when a resource or place choice is ambiguous.",
              "2. Fetch the chosen package with `bcn_get_package`, then choose a resource. Prefer DataStore-active resources when the user needs filters, fields, pagination, or analysis.",
              "3. Inspect the resource with `bcn_get_resource_info`. Use returned field IDs exactly in `bcn_query_resource` filters, fields, and sort.",
              "4. When the user gives a named place rather than coordinates, call `bcn_resolve_place`. Point candidates feed `bcn_query_resource_geo.near`; district/neighborhood candidates can also return `area_ref` and `bbox` for `bcn_query_resource_geo.within_place`.",
              "5. For place-aware questions, use `bcn_query_resource_geo` with `near`, `bbox`, `within_place`, `contains`, and optional `group_by`. It works across DataStore-active resources and safe BCN-hosted CSV/JSON downloads when WGS84 coordinate fields exist; active DataStore `near`/`bbox` calls use generated CKAN SQL internally, and grouped `near` results include nearest samples.",
              "6. Query active DataStore resources with `bcn_query_resource`. Pass structured `filters` as a JSON object; do not pass raw CKAN SQL or URL fragments.",
              "7. For inactive DataStore resources when only a sample is needed, call `bcn_preview_resource` for a bounded CSV/JSON preview. Treat it as a sample, not a full export.",
              "8. Cite `bcn_get_package`, `bcn_get_resource_info`, or the `bcn://packages/{package_id}` / `bcn://resources/{resource_id}/schema` resources.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "bcn_citation",
    {
      title: "bcn.citation",
      description: "Template for citing Open Data BCN packages and resources.",
    },
    () => ({
      description: "Fill-in citation template for Open Data BCN metadata.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create a concise citation from `bcn_get_package`, `bcn_get_resource_info`, or BCN resource output.",
              "",
              "Use the package or resource title, `provenance.source_url`, `last_updated`, and `provenance.license_or_terms`. Leave unavailable fields out instead of inventing values.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerResource(
    "bcn_package",
    new ResourceTemplate("bcn://packages/{package_id}", { list: undefined }),
    {
      title: "Open Data BCN Package",
      description: "Open Data BCN package metadata returned by bcn_get_package.data.",
      mimeType: "application/json",
    },
    async (uri, variables, extra) => {
      const packageId = getBcnTemplateVariable("package_id", variables.package_id);
      const result = await getBcnPackage({ package_id: packageId }, config, {
        logger: logger.child({ op: "package_resource" }),
        signal: extra.signal,
      });

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(toJsonSafeValue(result.data) ?? null),
          },
        ],
      };
    },
  );

  server.registerResource(
    "bcn_resource_schema",
    new ResourceTemplate("bcn://resources/{resource_id}/schema", { list: undefined }),
    {
      title: "Open Data BCN Resource Schema",
      description:
        "Open Data BCN resource metadata and DataStore fields returned by bcn_get_resource_info.data.",
      mimeType: "application/json",
    },
    async (uri, variables, extra) => {
      const resourceId = getBcnTemplateVariable("resource_id", variables.resource_id);
      const result = await getBcnResourceInfo({ resource_id: resourceId }, config, {
        logger: logger.child({ op: "resource_schema" }),
        signal: extra.signal,
      });

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(toJsonSafeValue(result.data) ?? null),
          },
        ],
      };
    },
  );
}

function createBcnSchemas(config: AppConfig) {
  const defaultSearchLimit = Math.min(10, config.maxResults);
  const defaultPreviewLimit = Math.min(20, config.maxResults);
  const positiveLimitSchema = z
    .number()
    .int()
    .min(1)
    .max(config.maxResults)
    .optional()
    .describe(`Rows to return. Server maximum: ${config.maxResults}.`);
  const offsetSchema = z.number().int().min(0).optional();
  const packageSummarySchema = z.object({
    resource_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    datastore_active: z.boolean(),
    format: z.string().nullable(),
    last_modified: z.string().nullable(),
    mimetype: z.string().nullable(),
    url: z.string().nullable(),
  });
  const provenanceBaseSchema = z.object({
    source: z.literal("bcn"),
    source_url: z.string().url(),
    id: z.string(),
    language: z.literal("ca"),
  });
  const operationProvenanceSchema = provenanceBaseSchema.extend({
    last_updated: z.null(),
    license_or_terms: z.null(),
  });
  const datasetProvenanceSchema = provenanceBaseSchema.extend({
    last_updated: z.string().nullable(),
    license_or_terms: z.string().nullable(),
  });
  const packageCardSchema = z.object({
    package_id: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    license_or_terms: z.string().nullable(),
    metadata_modified: z.string().nullable(),
    resource_count: z.number().int().nonnegative(),
    resources: z.array(packageSummarySchema),
    source_url: z.string().url(),
    provenance: datasetProvenanceSchema,
  });
  const packageDataSchema = packageCardSchema.extend({
    tags: z.array(z.string()),
  });
  const datastoreFieldSchema = z.object({
    id: z.string(),
    type: z.string(),
  });
  const resourceInfoSchema = z.object({
    resource_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    datastore_active: z.boolean(),
    format: z.string().nullable(),
    last_modified: z.string().nullable(),
    license_or_terms: z.string().nullable(),
    mimetype: z.string().nullable(),
    package_id: z.string().nullable(),
    package_title: z.string().nullable(),
    url: z.string().nullable(),
    provenance: datasetProvenanceSchema,
    fields: z.array(datastoreFieldSchema).nullable(),
    suggested_next_action: z.string(),
  });
  const queryDataSchema = z.object({
    resource_id: z.string(),
    request_method: z.literal("POST"),
    request_url: z.string().url(),
    request_body: z.record(jsonValueSchema),
    filters: z.record(jsonValueSchema).optional(),
    q: z.string().optional(),
    fields: z.array(datastoreFieldSchema),
    sort: z.string().optional(),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    total: z.number().int().nonnegative().nullable(),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncation_reason: z.enum(["byte_cap", "row_cap"]).optional(),
    truncation_hint: z.string().optional(),
    rows: z.array(z.record(jsonValueSchema)),
  });
  const previewDataSchema = z.object({
    resource_id: z.string(),
    resource_name: z.string(),
    package_id: z.string().nullable(),
    request_method: z.literal("GET"),
    download_url: z.string().url(),
    media_type: z.string().nullable(),
    charset: z.string(),
    format: z.enum(["csv", "json"]),
    delimiter: z.enum([",", ";", "tab"]).optional(),
    limit: z.number().int().min(1),
    columns: z.array(z.string()),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncation_reason: z.enum(["byte_cap", "row_cap"]).optional(),
    truncation_hint: z.string().optional(),
    rows: z.array(z.record(jsonValueSchema)),
  });
  const geoCoordinateSchema = z.object({
    lat: z.number(),
    lon: z.number(),
  });
  const geoNearSchema = geoCoordinateSchema.extend({
    radius_m: z.number().positive().max(5_000),
  });
  const withinPlaceSchema = z.object({
    source_resource_id: z.string(),
    row_id: z.union([z.string(), z.number()]),
    geometry_field: z.string().trim().min(1).optional(),
  });
  const areaFilterSchema = z.object({
    mode: z.literal("polygon"),
    source_resource_id: z.string(),
    row_id: z.union([z.string(), z.number()]),
    geometry_field: z.string(),
    geometry_type: areaGeometryTypeSchema,
    bbox: geoBboxSchema,
  });
  const placeDataSchema = z.object({
    query: z.string(),
    query_variants: z.array(z.string()),
    kinds: z.array(placeKindSchema).optional(),
    bbox: geoBboxSchema.optional(),
    strategy: z.literal("datastore"),
    limit: z.number().int().min(1),
    candidate_count: z.number().int().nonnegative(),
    candidates: z.array(placeCandidateSchema),
    truncated: z.boolean(),
  });
  const recommendResourcesDataSchema = z.object({
    query: z.string(),
    normalized_query: z.string(),
    task: recommendationTaskSchema.optional(),
    place_kind: recommendationPlaceKindSchema.optional(),
    limit: z.number().int().min(1),
    recommendation_count: z.number().int().nonnegative(),
    recommendations: z.array(recommendationSchema),
    truncated: z.boolean(),
  });
  const geoRowSchema = z.record(jsonValueSchema).and(
    z.object({
      _geo: z.record(jsonValueSchema),
    }),
  );
  const geoGroupSchema = z.object({
    key: jsonValueSchema,
    count: z.number().int().nonnegative(),
    min_distance_m: z.number().nonnegative().optional(),
    sample: z.record(jsonValueSchema).optional(),
    sample_nearest: z.record(jsonValueSchema).optional(),
  });
  const geoDataSchema = z.object({
    resource_id: z.string(),
    strategy: z.enum(["datastore", "download_stream"]),
    datastore_mode: z.enum(["scan", "sql"]).optional(),
    request_method: z.enum(["GET", "POST"]),
    request_url: z.string().url(),
    logical_request_body: z.record(jsonValueSchema).optional(),
    coordinate_fields: z.object({
      lat: z.string(),
      lon: z.string(),
    }),
    area_filter: areaFilterSchema.optional(),
    near: geoNearSchema.optional(),
    bbox: geoBboxSchema.optional(),
    filters: z.record(jsonValueSchema).optional(),
    contains: z.record(z.string()).optional(),
    fields: z.array(z.string()).optional(),
    group_by: z.string().optional(),
    group_limit: z.number().int().min(1).optional(),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    scanned_row_count: z.number().int().nonnegative(),
    matched_row_count: z.number().int().nonnegative(),
    row_count: z.number().int().nonnegative(),
    rows: z.array(geoRowSchema),
    groups: z.array(geoGroupSchema).optional(),
    truncated: z.boolean(),
    truncation_reason: z.enum(["byte_cap", "row_cap", "scan_cap"]).optional(),
    truncation_hint: z.string().optional(),
    upstream_bbox_total: z.number().int().nonnegative().nullable().optional(),
    upstream_prefilter_total: z.number().int().nonnegative().nullable().optional(),
    upstream_total: z.number().int().nonnegative().nullable().optional(),
  });
  const errorSchema = z.object({
    source: z.literal("bcn"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    status: z.number().int().optional(),
    source_error: jsonValueSchema.optional(),
  });
  const toolResultSchema = (dataSchema: z.ZodTypeAny) =>
    z.object({
      data: dataSchema.nullable(),
      provenance: operationProvenanceSchema,
      error: errorSchema.optional(),
    });
  return {
    inputs: {
      searchPackages: {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(config.maxResults).default(defaultSearchLimit),
        offset: z.number().int().min(0).default(0),
      },
      getPackage: {
        package_id: z.string(),
      },
      getResourceInfo: {
        resource_id: z.string(),
      },
      queryResource: {
        resource_id: z.string(),
        filters: z.record(jsonValueSchema).optional(),
        q: z.string().trim().min(1).optional(),
        fields: z.array(z.string()).optional(),
        sort: z.string().trim().min(1).optional(),
        limit: positiveLimitSchema,
        offset: offsetSchema,
      },
      resolvePlace: {
        query: z.string().trim().min(1),
        kinds: z.array(placeKindSchema).optional(),
        bbox: geoBboxSchema.optional(),
        limit: positiveLimitSchema,
      },
      recommendResources: {
        query: z.string().trim().min(1),
        task: recommendationTaskSchema.optional(),
        place_kind: recommendationPlaceKindSchema.optional(),
        limit: positiveLimitSchema,
      },
      cityQuery: {
        query: z.string().trim().min(1),
        task: recommendationTaskSchema.optional(),
        place_kind: recommendationPlaceKindSchema.optional(),
        place_query: z.string().trim().min(1).optional(),
        resource_id: z.string().trim().min(1).optional(),
        fields: z.array(z.string()).optional(),
        filters: z.record(jsonValueSchema).optional(),
        q: z.string().trim().min(1).optional(),
        group_by: z.string().trim().min(1).optional(),
        limit: positiveLimitSchema,
        offset: offsetSchema,
        radius_m: z.number().positive().max(5_000).optional(),
        sort: z.string().trim().min(1).optional(),
      },
      queryResourceGeo: {
        resource_id: z.string(),
        near: geoNearSchema.partial({ radius_m: true }).optional(),
        bbox: geoBboxSchema.optional(),
        within_place: withinPlaceSchema.optional(),
        lat_field: z.string().trim().min(1).optional(),
        lon_field: z.string().trim().min(1).optional(),
        filters: z.record(jsonValueSchema).optional(),
        contains: z.record(z.string()).optional(),
        fields: z.array(z.string()).optional(),
        limit: positiveLimitSchema,
        offset: offsetSchema,
        group_by: z.string().trim().min(1).optional(),
        group_limit: positiveLimitSchema,
      },
      previewResource: {
        resource_id: z.string(),
        limit: positiveLimitSchema.default(defaultPreviewLimit),
      },
    },
    outputs: {
      searchPackages: toolResultSchema(
        z.object({
          query: z.string(),
          limit: z.number().int().min(1),
          offset: z.number().int().min(0),
          total: z.number().int().nonnegative(),
          results: z.array(packageCardSchema),
        }),
      ),
      getPackage: toolResultSchema(packageDataSchema),
      getResourceInfo: toolResultSchema(resourceInfoSchema),
      queryResource: toolResultSchema(queryDataSchema),
      resolvePlace: toolResultSchema(placeDataSchema),
      recommendResources: toolResultSchema(recommendResourcesDataSchema),
      planQuery: toolResultSchema(cityPlanDataSchema),
      executeCityQuery: toolResultSchema(executeCityQueryDataSchema),
      answerCityQuery: toolResultSchema(answerCityQueryDataSchema),
      queryResourceGeo: toolResultSchema(geoDataSchema),
      previewResource: toolResultSchema(previewDataSchema),
    },
  };
}

async function wrapBcnTool<
  T extends { data: unknown; provenance: ReturnType<typeof createBcnOperationProvenance> },
>(operation: string, run: () => Promise<T> | T) {
  try {
    const structuredContent = await run();

    return {
      content: createJsonTextContent(structuredContent),
      structuredContent: structuredContent as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const structuredContent = {
      data: null,
      provenance: createBcnOperationProvenance(operation),
      error: toBcnToolError(error),
    };

    return {
      content: createJsonTextContent(structuredContent),
      structuredContent: structuredContent as Record<string, unknown>,
      isError: true,
    };
  }
}

function getBcnTemplateVariable(name: string, value: string | string[] | undefined): string {
  if (value === undefined) {
    throw new BcnError("invalid_input", `Missing ${name} in Open Data BCN resource URI.`);
  }

  if (Array.isArray(value)) {
    throw new BcnError(
      "invalid_input",
      `Open Data BCN resource URI must include exactly one ${name}.`,
    );
  }

  return normalizeBcnId(name, value);
}

function toBcnToolError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  source: "bcn";
  source_error?: unknown;
  status?: number;
} {
  if (isBcnError(error)) {
    const sourceError =
      error.source_error === undefined ? undefined : toJsonSafeValue(error.source_error);

    return {
      source: "bcn",
      code: error.code,
      message: addBcnNextStep(error.message, error.code, error.retryable),
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(sourceError === undefined ? {} : { source_error: sourceError }),
    };
  }

  return {
    source: "bcn",
    code: "unexpected_error",
    message: error instanceof Error ? error.message : "Unexpected Open Data BCN failure.",
    retryable: false,
  };
}

function addBcnNextStep(message: string, code: string, retryable: boolean): string {
  const guidance = getBcnNextStepGuidance(code, retryable);
  return guidance === undefined ? message : `${message} Next step: ${guidance}`;
}

function getBcnNextStepGuidance(code: string, retryable: boolean): string | undefined {
  switch (code) {
    case "invalid_input":
      return "use package and resource IDs returned by BCN tools; inactive DataStore resources should use bcn_preview_resource or bcn_query_resource_geo when coordinate fields exist.";
    case "invalid_response":
      return "try bcn_get_resource_info, lower limit, or switch between query and preview based on DataStore activity.";
    case "network_error":
    case "timeout":
    case "http_error":
      return retryable
        ? "retry the request; if it repeats, lower limit or narrow filters."
        : "verify package/resource IDs with bcn_search_packages and bcn_get_package.";
    default:
      return undefined;
  }
}
