import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  createJsonTextContent,
  getJsonByteLength,
  getJsonToolResultByteLength,
} from "../../sources/common/caps.js";
import { toJsonSafeValue } from "../../sources/common/json-safe.js";
import {
  listIdescatNodes,
  listIdescatStatistics,
  listIdescatTableGeos,
  listIdescatTables,
} from "../../sources/idescat/catalog.js";
import {
  IdescatError,
  type IdescatLanguage,
  isIdescatError,
} from "../../sources/idescat/client.js";
import { getIdescatTableData } from "../../sources/idescat/data.js";
import {
  createIdescatOperationProvenance,
  getIdescatTableMetadata,
  type IdescatTableMetadata,
} from "../../sources/idescat/metadata.js";
import { searchIdescatTables } from "../../sources/idescat/search.js";
import { jsonObjectSchema, jsonValueSchema } from "../schemas.js";

const idescatLangSchema = z.enum(["ca", "es", "en"]).default("ca");

export function registerIdescatTools(server: McpServer, config: AppConfig, logger: Logger): void {
  const schemas = createIdescatSchemas();

  server.registerTool(
    "idescat_search_tables",
    {
      title: "idescat.search_tables",
      description: [
        "Topic discovery for IDESCAT Tables v2.",
        "Search by subject and optional geography words or named places such as comarca, municipi, Maresme, Barcelonès, or Girona.",
        "Common semantic aliases such as taxa atur, paro, renda per capita, family income, and poblacio municipal can be used directly.",
        "Prefer results whose geo_candidates include the requested geo_id, then confirm with idescat_list_table_geos.",
        "Reuse the returned statistics_id, node_id, and table_id with idescat_list_table_geos.",
        "Search/list provenance is discovery-only; cite idescat_get_table_metadata or the metadata resource.",
      ].join(" "),
      inputSchema: schemas.inputs.searchTables,
      outputSchema: schemas.outputs.searchTables,
    },
    async (input) =>
      wrapIdescatTool("table_search", input.lang, async () =>
        searchIdescatTables(input, config, { logger: logger.child({ op: "table_search" }) }),
      ),
  );

  server.registerTool(
    "idescat_list_statistics",
    {
      title: "idescat.list_statistics",
      description:
        "Browse fallback when idescat_search_tables is too broad or empty. Start here, then call idescat_list_nodes with a returned statistics_id.",
      inputSchema: schemas.inputs.listStatistics,
      outputSchema: schemas.outputs.listStatistics,
    },
    async (input, extra) =>
      wrapIdescatTool("list_statistics", input.lang, async () =>
        listIdescatStatistics(input, config, {
          logger: logger.child({ op: "list_statistics" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "idescat_list_nodes",
    {
      title: "idescat.list_nodes",
      description:
        "Browse nodes under an IDESCAT statistic. Use a statistics_id from idescat_list_statistics, then call idescat_list_tables with the returned node_id.",
      inputSchema: schemas.inputs.listNodes,
      outputSchema: schemas.outputs.listNodes,
    },
    async (input, extra) =>
      wrapIdescatTool("list_nodes", input.lang, async () =>
        listIdescatNodes(input, config, {
          logger: logger.child({ op: "list_nodes" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "idescat_list_tables",
    {
      title: "idescat.list_tables",
      description:
        "Browse tables within an IDESCAT statistic node. Use returned statistics_id, node_id, and table_id with idescat_list_table_geos before metadata or data.",
      inputSchema: schemas.inputs.listTables,
      outputSchema: schemas.outputs.listTables,
    },
    async (input, extra) =>
      wrapIdescatTool("list_tables", input.lang, async () =>
        listIdescatTables(input, config, {
          logger: logger.child({ op: "list_tables" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "idescat_list_table_geos",
    {
      title: "idescat.list_table_geos",
      description:
        "Required bridge from table discovery to metadata/data. Choose a returned geo_id, then call idescat_get_table_metadata before idescat_get_table_data.",
      inputSchema: schemas.inputs.listTableGeos,
      outputSchema: schemas.outputs.listTableGeos,
    },
    async (input, extra) =>
      wrapIdescatTool("list_table_geos", input.lang, async () =>
        listIdescatTableGeos(input, config, {
          logger: logger.child({ op: "list_table_geos" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerTool(
    "idescat_get_table_metadata",
    {
      title: "idescat.get_table_metadata",
      description: [
        "Inspect an IDESCAT table after selecting geo_id with idescat_list_table_geos.",
        "Optionally pass place_query with the original user place phrase, such as Maresme or renda Girona, to receive filter_guidance.",
        "Use returned dimension IDs, category IDs, and filter_guidance.recommended_data_call exactly in idescat_get_table_data filters; use this tool or its metadata resource for citations.",
      ].join(" "),
      inputSchema: schemas.inputs.getTableMetadata,
      outputSchema: schemas.outputs.getTableMetadata,
    },
    async (input, extra) =>
      wrapIdescatTool("table_metadata", input.lang, async () => {
        const result = await getIdescatTableMetadata(input, config, {
          logger: logger.child({ op: "table_metadata" }),
          signal: extra.signal,
        });

        return {
          ...result,
          data: degradeMetadataForTool(result.data, result.provenance, config.responseMaxBytes),
        };
      }),
  );

  server.registerTool(
    "idescat_get_table_data",
    {
      title: "idescat.get_table_data",
      description: [
        "Fetch a bounded, flattened IDESCAT data extract only after idescat_list_table_geos and idescat_get_table_metadata.",
        "Every request requires statistics_id, node_id, table_id, and geo_id.",
        "Use metadata dimension/category IDs exactly in filters, and use last for recent periods.",
        "This is not an exhaustive export tool; if IDESCAT returns narrow_filters, call metadata and retry with filters or last.",
      ].join(" "),
      inputSchema: schemas.inputs.getTableData,
      outputSchema: schemas.outputs.getTableData,
    },
    async (input, extra) =>
      wrapIdescatTool("table_data", input.lang, async () =>
        getIdescatTableData(input, config, {
          logger: logger.child({ op: "table_data" }),
          signal: extra.signal,
        }),
      ),
  );

  server.registerPrompt(
    "idescat_query_workflow",
    {
      title: "idescat.query_workflow",
      description: "Guide a user through finding, inspecting, and querying an IDESCAT table.",
    },
    () => ({
      description: "IDESCAT table search, metadata, and bounded data workflow guidance.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use this prescriptive workflow for IDESCAT Tables v2 questions.",
              "",
              "1. Search first with `idescat_search_tables` for topic discovery. Geography words, named places, and common semantic aliases such as taxa atur, paro, renda per capita, family income, or poblacio municipal can be included; prefer results whose `geo_candidates` include the requested geo_id. If search is empty or too broad, browse with `idescat_list_statistics` -> `idescat_list_nodes` -> `idescat_list_tables`.",
              "2. Call `idescat_list_table_geos` with the chosen statistics_id/node_id/table_id. For discovery workflows, continue only after a `geo_id` has been selected or supplied.",
              "3. Call `idescat_get_table_metadata` with the selected geo_id. If the user named a place, pass the original phrase in `place_query`. Use returned dimension IDs and category IDs exactly in `filters`; prefer `filter_guidance` when present; do not invent display-label filters.",
              "4. Call `idescat_get_table_data` for a bounded extract. Prefer `filter_guidance.recommended_data_call` when present, then dimension filters and `last` over raising `limit`; do not use it as a full table export.",
              "5. Cite `idescat_get_table_metadata` output or the `idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata` resource. Treat search/list provenance as discovery-only.",
              "",
              "Recovery rules:",
              "- Empty search: broaden terms or use the browse path.",
              "- Requested geography absent: try another search result or explain the available geographies from idescat_list_table_geos; do not invent a geo_id.",
              "- No geos: try another table from search/list; metadata/data require geo_id.",
              "- `invalid_input`: reuse IDs returned by IDESCAT search/list/geos/metadata tools.",
              "- `narrow_filters`: call metadata, then retry data with dimension filters or `last`.",
              "- Truncation: keep the same IDs and narrow with filters, `last`, or lower `limit`.",
              "- Filter cap errors: reduce or split filters before retrying.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "idescat_citation",
    {
      title: "idescat.citation",
      description: "Template for citing IDESCAT table metadata.",
    },
    () => ({
      description: "Fill-in citation template for IDESCAT table metadata.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create a concise citation from `idescat_get_table_metadata` output or the `idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata` resource.",
              "",
              "Use the table title, `provenance.source_url`, `last_updated`, `statistical_sources`, `links`, and `provenance.license_or_terms`. Leave unavailable fields out instead of inventing values.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerResource(
    "idescat_table_metadata",
    new ResourceTemplate(
      "idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata",
      { list: undefined },
    ),
    {
      title: "IDESCAT Table Metadata",
      description: "IDESCAT Tables v2 metadata artifact for a statistics/node/table/geo tuple.",
      mimeType: "application/json",
    },
    async (uri, variables, extra) => {
      const input = {
        statistics_id: getSingleTemplateVariable("statistics_id", variables.statistics_id),
        node_id: getSingleTemplateVariable("node_id", variables.node_id),
        table_id: getSingleTemplateVariable("table_id", variables.table_id),
        geo_id: getSingleTemplateVariable("geo_id", variables.geo_id),
        lang: "ca" as const,
      };
      const result = await getIdescatTableMetadata(input, config, {
        logger: logger.child({ op: "table_metadata_resource" }),
        signal: extra.signal,
      });
      const metadata = degradeMetadataForResource(
        result.data,
        uri.href,
        "application/json",
        config.responseMaxBytes,
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(toJsonSafeValue(metadata) ?? null),
          },
        ],
      };
    },
  );
}

function createIdescatSchemas() {
  const idSchema = z.string();
  const languageSchema = z.enum(["ca", "es", "en"]);
  const listBase = {
    lang: idescatLangSchema,
    limit: z.number().optional(),
    offset: z.number().optional(),
  };

  const provenanceSchema = z.object({
    source: z.literal("idescat"),
    source_url: z.string().url(),
    id: z.string(),
    last_updated: z.string().nullable(),
    license_or_terms: z.string().nullable(),
    language: languageSchema,
  });
  const errorSchema = z.object({
    source: z.literal("idescat"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    status: z.number().int().optional(),
    source_error: jsonValueSchema.optional(),
  });
  const unitSchema = z.object({
    decimals: z.number().optional(),
    symbol: z.string().optional(),
  });
  const metadataLinkSchema = z.object({
    rel: z.string(),
    href: z.string(),
    label: z.string().optional(),
    class: z.string().optional(),
    type: z.string().optional(),
    extension: jsonObjectSchema.optional(),
  });
  const metadataDegradationSchema = z.object({
    dropped: z.array(z.enum(["categories_for_dimensions", "extensions", "links", "notes"])),
    dimension_ids: z.array(z.string()).optional(),
    hint: z.string(),
  });
  const statusLabelsSchema = z.record(
    z.object({
      label: z.string(),
      raw: jsonObjectSchema.optional(),
    }),
  );
  const dimensionCategorySchema = z.object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    parent: z.string().optional(),
    status: z.string().optional(),
    unit: unitSchema.optional(),
  });
  const dimensionBreakSchema = z.object({
    id: z.string(),
    label: z.string(),
    time: z.string(),
    raw: jsonObjectSchema.optional(),
  });
  const dimensionSchema = z.object({
    id: z.string(),
    label: z.string(),
    role: z.enum(["geo", "metric", "time"]).optional(),
    size: z.number().int().nonnegative(),
    unit: unitSchema.optional(),
    status: z.record(z.string()).optional(),
    categories: z.array(dimensionCategorySchema),
    categories_omitted: z.boolean().optional(),
    breaks: z.array(dimensionBreakSchema).optional(),
    extensions: jsonObjectSchema.optional(),
  });
  const filterValueSchema = z.union([z.string(), z.array(z.string())]);
  const filterGuidanceSchema = z.object({
    place_matches: z
      .array(
        z.object({
          dimension_id: z.string(),
          dimension_label: z.string(),
          category_id: z.string(),
          category_label: z.string(),
        }),
      )
      .optional(),
    recommended_filters: z.record(filterValueSchema).optional(),
    latest: z
      .object({
        last: z.literal(1),
        time_dimension_ids: z.array(z.string()),
      })
      .optional(),
    recommended_data_call: z
      .object({
        filters: z.record(filterValueSchema).optional(),
        last: z.literal(1).optional(),
        limit: z.literal(20),
      })
      .optional(),
    unresolved_place_terms: z.array(z.string()).optional(),
    needs_filter_dimensions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          role: z.enum(["geo", "metric", "time"]).optional(),
          size: z.number().int().nonnegative(),
          candidates: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
            }),
          ),
        }),
      )
      .optional(),
  });
  const unitsSchema = z
    .object({
      default: unitSchema.optional(),
      by_dimension: z.record(z.record(unitSchema)).optional(),
    })
    .nullable();
  const metadataSchema = z.object({
    statistics_id: z.string(),
    node_id: z.string(),
    table_id: z.string(),
    geo_id: z.string(),
    lang: languageSchema,
    title: z.string(),
    description: z.string().optional(),
    last_updated: z.string().optional(),
    terms_url: z.string().optional(),
    statistical_sources: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    dimensions: z.array(dimensionSchema),
    filter_guidance: filterGuidanceSchema.optional(),
    units: unitsSchema.optional(),
    status_labels: statusLabelsSchema.optional(),
    links: z.array(metadataLinkSchema).optional(),
    correction_links: z.array(metadataLinkSchema).optional(),
    alternate_geographies: z.array(metadataLinkSchema).optional(),
    related_tables: z.array(metadataLinkSchema).optional(),
    extensions: jsonObjectSchema.optional(),
    degradation: metadataDegradationSchema.optional(),
    provenance: provenanceSchema,
  });
  const collectionSchema = z.object({
    href: z.string(),
    label: z.string(),
    lang: languageSchema,
    version: z.string().nullable(),
  });
  const listDataSchema = (itemSchema: z.ZodTypeAny) =>
    z.object({
      collection: collectionSchema,
      items: z.array(itemSchema),
      limit: z.number().int().min(1),
      offset: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
      truncation_reason: z.enum(["byte_cap", "row_cap"]).optional(),
    });
  const statisticItemSchema = z.object({
    statistics_id: z.string(),
    label: z.string(),
    href: z.string(),
  });
  const nodeItemSchema = statisticItemSchema.extend({
    node_id: z.string(),
  });
  const tableItemSchema = nodeItemSchema.extend({
    table_id: z.string(),
    updated: z.string().optional(),
  });
  const geoItemSchema = tableItemSchema.extend({
    geo_id: z.string(),
  });
  const searchCardSchema = z.object({
    statistics_id: z.string(),
    node_id: z.string(),
    table_id: z.string(),
    label: z.string(),
    ancestor_labels: z.object({
      statistic: z.string(),
      node: z.string(),
    }),
    source_url: z.string().url(),
    geo_candidates: z.array(z.string()).nullable(),
    lang: languageSchema,
    score: z.number(),
  });
  const searchDataSchema = z.object({
    query: z.string(),
    requested_lang: languageSchema,
    lang: languageSchema,
    limit: z.number().int().min(1),
    total: z.number().int().nonnegative(),
    generated_at: z.string(),
    index_version: z.string(),
    source_collection_urls: z.array(z.string()),
    results: z.array(searchCardSchema),
  });
  const dataRowSchema = z.object({
    value: z.number().nullable(),
    dimensions: z.record(
      z.object({
        id: z.string(),
        label: z.string(),
      }),
    ),
    status: z
      .object({
        code: z.string(),
        label: z.string().optional(),
      })
      .optional(),
  });
  const tableDataSchema = z.object({
    statistics_id: z.string(),
    node_id: z.string(),
    table_id: z.string(),
    geo_id: z.string(),
    lang: languageSchema,
    request_method: z.enum(["GET", "POST"]),
    request_url: z.string().url(),
    request_body_params: z.record(z.string()).optional(),
    logical_request_url: z.string().url(),
    filters: z.record(filterValueSchema).optional(),
    last: z.number().int().min(1).optional(),
    limit: z.number().int().min(1),
    dimension_order: z.array(z.string()),
    size: z.array(z.number().int().nonnegative()),
    units: unitsSchema.optional(),
    selected_cell_count: z.number().int().nonnegative(),
    row_count: z.number().int().nonnegative(),
    rows: z.array(dataRowSchema),
    truncated: z.boolean(),
    truncation_reason: z.enum(["byte_cap", "row_cap"]).optional(),
    truncation_hint: z.string().optional(),
    notes: z.array(z.string()).optional(),
    source_extensions: jsonObjectSchema.optional(),
  });
  const toolResultSchema = (dataSchema: z.ZodTypeAny) =>
    z.object({
      data: dataSchema.nullable(),
      provenance: provenanceSchema,
      error: errorSchema.optional(),
    });

  return {
    inputs: {
      searchTables: {
        query: z.string().trim().min(1),
        lang: idescatLangSchema,
        limit: z.number().optional(),
      },
      listStatistics: listBase,
      listNodes: {
        ...listBase,
        statistics_id: idSchema,
      },
      listTables: {
        ...listBase,
        statistics_id: idSchema,
        node_id: idSchema,
      },
      listTableGeos: {
        ...listBase,
        statistics_id: idSchema,
        node_id: idSchema,
        table_id: idSchema,
      },
      getTableMetadata: {
        statistics_id: idSchema,
        node_id: idSchema,
        table_id: idSchema,
        geo_id: idSchema,
        lang: idescatLangSchema,
        place_query: z.string().trim().min(1).optional(),
      },
      getTableData: {
        statistics_id: idSchema,
        node_id: idSchema,
        table_id: idSchema,
        geo_id: idSchema,
        lang: idescatLangSchema,
        filters: z.record(z.unknown()).optional(),
        last: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    outputs: {
      searchTables: toolResultSchema(searchDataSchema),
      listStatistics: toolResultSchema(listDataSchema(statisticItemSchema)),
      listNodes: toolResultSchema(listDataSchema(nodeItemSchema)),
      listTables: toolResultSchema(listDataSchema(tableItemSchema)),
      listTableGeos: toolResultSchema(listDataSchema(geoItemSchema)),
      getTableMetadata: toolResultSchema(metadataSchema),
      getTableData: toolResultSchema(tableDataSchema),
    },
  };
}

async function wrapIdescatTool<
  T extends { data: unknown; provenance: ReturnType<typeof createIdescatOperationProvenance> },
>(operation: string, lang: IdescatLanguage | undefined, run: () => Promise<T> | T) {
  try {
    const structuredContent = await run();

    return {
      content: createJsonTextContent(structuredContent),
      structuredContent: structuredContent as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const structuredContent = {
      data: null,
      provenance: createIdescatOperationProvenance(operation, lang ?? "ca"),
      error: toIdescatToolError(error),
    };

    return {
      content: createJsonTextContent(structuredContent),
      structuredContent: structuredContent as Record<string, unknown>,
      isError: true,
    };
  }
}

function toIdescatToolError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  source: "idescat";
  source_error?: unknown;
  status?: number;
} {
  if (isIdescatError(error)) {
    const sourceError =
      error.source_error === undefined ? undefined : toJsonSafeValue(error.source_error);

    return {
      source: "idescat",
      code: error.code,
      message: addIdescatNextStep(error.message, error.code, error.retryable, sourceError),
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(sourceError === undefined ? {} : { source_error: sourceError }),
    };
  }

  return {
    source: "idescat",
    code: "unexpected_error",
    message: error instanceof Error ? error.message : "Unexpected IDESCAT failure.",
    retryable: false,
  };
}

function addIdescatNextStep(
  message: string,
  code: string,
  retryable: boolean,
  sourceError: unknown,
): string {
  const guidance = getIdescatNextStepGuidance(code, retryable, sourceError);

  return guidance === undefined ? message : `${message} Next step: ${guidance}`;
}

function getIdescatNextStepGuidance(
  code: string,
  retryable: boolean,
  sourceError: unknown,
): string | undefined {
  if (hasFilterCapRule(sourceError)) {
    return "reduce or split filters and retry.";
  }

  switch (code) {
    case "invalid_input":
      return "reuse IDs returned by IDESCAT search/list/geos/metadata tools.";
    case "narrow_filters":
      return "call idescat_get_table_metadata, then retry with dimension filters or last.";
    case "network_error":
    case "timeout":
    case "http_error":
      return retryable
        ? "retry the request; if it repeats, narrow filters or use last."
        : "verify IDs and filters with search/list/geos/metadata before retrying.";
    default:
      return undefined;
  }
}

function hasFilterCapRule(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "rule" in value &&
    typeof (value as { rule?: unknown }).rule === "string"
  );
}

function getSingleTemplateVariable(name: string, value: string | string[] | undefined): string {
  if (value === undefined) {
    throw new IdescatError("invalid_input", `Missing ${name} in IDESCAT metadata resource URI.`);
  }

  if (Array.isArray(value)) {
    throw new IdescatError(
      "invalid_input",
      `IDESCAT metadata resource URI must include exactly one ${name}.`,
    );
  }

  return value;
}

function degradeMetadataForTool(
  metadata: IdescatTableMetadata,
  provenance: ReturnType<typeof createIdescatOperationProvenance>,
  responseMaxBytes: number,
): IdescatTableMetadata {
  return degradeMetadata(
    metadata,
    (candidate) => getJsonToolResultByteLength({ data: candidate, provenance }),
    responseMaxBytes,
  );
}

function degradeMetadataForResource(
  metadata: IdescatTableMetadata,
  uri: string,
  mimeType: string,
  responseMaxBytes: number,
): IdescatTableMetadata {
  return degradeMetadata(
    metadata,
    (candidate) =>
      getJsonByteLength({
        contents: [
          {
            uri,
            mimeType,
            text: JSON.stringify(toJsonSafeValue(candidate) ?? null),
          },
        ],
      }),
    responseMaxBytes,
  );
}

function degradeMetadata(
  metadata: IdescatTableMetadata,
  sizeOf: (metadata: IdescatTableMetadata) => number,
  responseMaxBytes: number,
): IdescatTableMetadata {
  let candidate = metadata;

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  const largeDimensions = candidate.dimensions
    .filter((dimension) => dimension.categories.length > 200)
    .map((dimension) => dimension.id);
  candidate = dropCategories(candidate, largeDimensions);

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  candidate = {
    ...candidate,
    links: undefined,
    correction_links: undefined,
    alternate_geographies: undefined,
    related_tables: undefined,
    degradation: addDegradation(candidate.degradation, "links", largeDimensions),
  };

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  candidate = {
    ...candidate,
    notes: undefined,
    degradation: addDegradation(candidate.degradation, "notes", largeDimensions),
  };

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  candidate = {
    ...candidate,
    extensions: undefined,
    degradation: addDegradation(candidate.degradation, "extensions", largeDimensions),
  };

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  candidate = dropCategories(
    candidate,
    candidate.dimensions.map((dimension) => dimension.id),
  );

  if (sizeOf(candidate) <= responseMaxBytes) {
    return candidate;
  }

  throw new IdescatError(
    "invalid_response",
    "IDESCAT metadata artifact exceeds response cap after degradation.",
  );
}

function dropCategories(
  metadata: IdescatTableMetadata,
  dimensionIds: string[],
): IdescatTableMetadata {
  if (dimensionIds.length === 0) {
    return metadata;
  }

  const dimensionIdSet = new Set(dimensionIds);
  const hasGeoDimension = metadata.dimensions.some(
    (dimension) => dimensionIdSet.has(dimension.id) && dimension.role === "geo",
  );

  return {
    ...metadata,
    dimensions: metadata.dimensions.map((dimension) =>
      dimensionIdSet.has(dimension.id)
        ? {
            ...dimension,
            categories: [],
            categories_omitted: true,
          }
        : dimension,
    ),
    degradation: addDegradation(
      metadata.degradation,
      "categories_for_dimensions",
      dimensionIds,
      hasGeoDimension,
    ),
  };
}

function addDegradation(
  existing: IdescatTableMetadata["degradation"],
  dropped: NonNullable<IdescatTableMetadata["degradation"]>["dropped"][number],
  dimensionIds: string[] = [],
  hasGeoDimension = false,
): IdescatTableMetadata["degradation"] {
  const droppedSet = new Set(existing?.dropped ?? []);
  droppedSet.add(dropped);
  const dimensionSet = new Set([...(existing?.dimension_ids ?? []), ...dimensionIds]);
  const geoHint = hasGeoDimension ? " call idescat_list_table_geos for geo dimensions;" : "";

  return {
    dropped: [...droppedSet],
    ...(dimensionSet.size > 0 ? { dimension_ids: [...dimensionSet] } : {}),
    hint: `metadata was reduced to fit the MCP response cap;${geoHint} call idescat_get_table_metadata for the original table when narrower metadata is sufficient`,
  };
}
