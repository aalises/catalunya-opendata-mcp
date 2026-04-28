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
import { BcnError, isBcnError } from "../../sources/bcn/client.js";
import { previewBcnResource } from "../../sources/bcn/preview.js";
import { queryBcnResource } from "../../sources/bcn/query.js";
import { getBcnResourceInfo } from "../../sources/bcn/resource.js";
import { createJsonTextContent } from "../../sources/common/caps.js";
import { toJsonSafeValue } from "../../sources/common/json-safe.js";
import { jsonValueSchema } from "../schemas.js";

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
              "1. Discover candidate packages with `bcn_search_packages`. Choose the package whose title, description, tags, and resource formats match the user's request.",
              "2. Fetch the chosen package with `bcn_get_package`, then choose a resource. Prefer DataStore-active resources when the user needs filters, fields, pagination, or analysis.",
              "3. Inspect the resource with `bcn_get_resource_info`. Use returned field IDs exactly in `bcn_query_resource` filters, fields, and sort.",
              "4. Query active DataStore resources with `bcn_query_resource`. Pass structured `filters` as a JSON object; do not pass raw CKAN SQL or URL fragments.",
              "5. For inactive DataStore resources, call `bcn_preview_resource` for a bounded CSV/JSON preview. Treat it as a sample, not a full export.",
              "6. Cite `bcn_get_package`, `bcn_get_resource_info`, or the `bcn://packages/{package_id}` / `bcn://resources/{resource_id}/schema` resources.",
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
      return "use package and resource IDs returned by BCN tools; inactive DataStore resources should use bcn_preview_resource.";
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
