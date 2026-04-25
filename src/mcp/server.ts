import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  createSocrataSearchProvenance,
  searchSocrataDatasets,
} from "../sources/socrata/catalog.js";
import { isSocrataError, normalizeSourceId, SocrataError } from "../sources/socrata/client.js";
import {
  createSocrataDescribeProvenance,
  describeSocrataDataset,
} from "../sources/socrata/dataset.js";
import { createSocrataQueryProvenance, querySocrataDataset } from "../sources/socrata/query.js";

export const serverName = "catalunya-opendata-mcp";
export const serverVersion = "0.1.0";

export function createPingMessage(name?: string): string {
  return `Hola${name ? `, ${name}` : ""}. ${serverName} is running.`;
}

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: serverName,
    version: serverVersion,
  });

  const socrataSearchDefaultLimit = Math.min(10, config.maxResults);
  const socrataSearchInputSchema = {
    query: z.string().trim().min(1).describe("Search text for the Socrata catalog."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(config.maxResults)
      .default(socrataSearchDefaultLimit)
      .describe(`Maximum number of datasets to return. Server maximum: ${config.maxResults}.`),
    offset: z.number().int().min(0).default(0).describe("Zero-based result offset for pagination."),
  };
  const socrataDescribeInputSchema = {
    source_id: z.string().describe("Socrata dataset identifier, such as v8i4-fa4q."),
  };
  const socrataQueryInputSchema = {
    source_id: z.string().describe("Socrata dataset identifier, such as v8i4-fa4q."),
    select: z
      .string()
      .optional()
      .describe("Raw SODA $select clause value using field_name values from describe."),
    where: z
      .string()
      .optional()
      .describe("Raw SODA $where clause value using field_name values from describe."),
    group: z.string().optional().describe("Raw SODA $group clause value for aggregate queries."),
    order: z
      .string()
      .optional()
      .describe("Raw SODA $order clause value. Supply this when using offset."),
    limit: z.number().optional().describe(`Rows to return. Server maximum: ${config.maxResults}.`),
    offset: z.number().optional().describe("Zero-based row offset for pagination."),
  };

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check that the Catalunya Open Data MCP server is running.",
      inputSchema: {
        name: z.string().optional().describe("Optional name to include in the response."),
      },
      outputSchema: {
        message: z.string(),
        server: z.string(),
      },
    },
    async ({ name }) => {
      const message = createPingMessage(name);

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        structuredContent: {
          message,
          server: serverName,
        },
      };
    },
  );

  server.registerTool(
    "socrata_search_datasets",
    {
      title: "socrata.search_datasets",
      description:
        "Discover dataset IDs and metadata from the Catalunya open data Socrata catalog.",
      inputSchema: socrataSearchInputSchema,
      outputSchema: socrataSearchDatasetsOutputSchema,
    },
    async (input, extra) => {
      try {
        const structuredContent = await searchSocrataDatasets(input, config, {
          signal: extra.signal,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const structuredContent = {
          data: null,
          provenance: createSocrataSearchProvenance(input),
          error: toSocrataToolError(error),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as Record<string, unknown>,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "socrata_describe_dataset",
    {
      title: "socrata.describe_dataset",
      description:
        "Describe a Catalunya open data Socrata dataset, including queryable API field names.",
      inputSchema: socrataDescribeInputSchema,
      outputSchema: socrataDescribeDatasetOutputSchema,
    },
    async (input, extra) => {
      try {
        const structuredContent = await describeSocrataDataset(input, config, {
          signal: extra.signal,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const structuredContent = {
          data: null,
          provenance: createSocrataDescribeProvenance(input),
          error: toSocrataToolError(error, "Unexpected Socrata describe failure."),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as Record<string, unknown>,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "socrata_query_dataset",
    {
      title: "socrata.query_dataset",
      // Keep this concise agent-facing guidance aligned with the longer
      // human-facing socrata_query_workflow prompt below.
      description: [
        "Query rows from a Catalunya open data Socrata dataset.",
        "Always call socrata_describe_dataset first and use returned field_name values, not display_name values.",
        "Pass clause values only, for example where: \"municipi = 'Girona'\"; never pass ?$where=... URL fragments.",
        "Supply order whenever using offset for stable pagination; without it, repeated calls may return duplicate or missing rows.",
        "Prefer narrowing filters or reducing $select over raising limit. Server caps row count and response bytes; truncation is signaled explicitly.",
        "Aggregate queries combine select with aggregate functions and group.",
      ].join(" "),
      inputSchema: socrataQueryInputSchema,
      outputSchema: socrataQueryDatasetOutputSchema,
    },
    async (input, extra) => {
      try {
        const structuredContent = await querySocrataDataset(input, config, {
          signal: extra.signal,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const structuredContent = {
          data: null,
          provenance: createSocrataQueryProvenance(input, config),
          error: toSocrataToolError(error, "Unexpected Socrata query failure."),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent: structuredContent as Record<string, unknown>,
          isError: true,
        };
      }
    },
  );

  server.registerPrompt(
    "socrata_query_workflow",
    {
      title: "socrata.query_workflow",
      description:
        "Guide a user through finding, describing, and querying a Catalunya Socrata dataset.",
    },
    () => ({
      description: "Socrata search, describe, and query workflow guidance.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            // Keep this human-facing prompt aligned with the concise
            // socrata_query_dataset tool description above.
            text: [
              "Use this workflow when helping someone query Catalunya open data from Socrata.",
              "",
              "1. Discover the dataset with `socrata_search_datasets`. Choose the result whose title and description best match the user's request, then keep its `source_id`.",
              "",
              "2. Inspect the schema with `socrata_describe_dataset`. Use the returned `field_name` values in query clauses. Do not use display names, translated labels, or names with spaces/accents unless they are explicitly returned as `field_name`.",
              "",
              "3. Query rows with `socrata_query_dataset`. Pass raw clause values only, not URL fragments. For example, use `where: \"municipi = 'Girona'\"`, not `where: \"?$where=municipi = 'Girona'\"`.",
              "",
              "4. For pagination, include `order` whenever using `offset`. Without a stable order, repeated pages may contain duplicate or missing rows.",
              "",
              '5. For aggregate queries, combine aggregate functions in `select` with `group`, such as `select: "comarca, count(*) as total"` and `group: "comarca"`. Do not mix ungrouped row-level fields into aggregate queries.',
              "",
              "6. If Socrata returns a 400, read the surfaced `error.message`. It includes the upstream error body when available, such as `query.soql.no-such-column` and the missing column name. Use that feedback with the described schema to correct the query.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "socrata_citation",
    {
      title: "socrata.citation",
      description: "Template for citing a Catalunya Socrata dataset from described metadata.",
    },
    () => ({
      description: "Fill-in citation template for Socrata dataset metadata.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create a concise citation for a Catalunya Socrata dataset using `socrata_describe_dataset` output or the `socrata://datasets/{source_id}/metadata` resource.",
              "",
              "Fill this template from the metadata:",
              "",
              "`{title}`. `{attribution}`. Source: `{source_domain}`. URL: `{web_url}` or `{provenance.source_url}`. Last updated: `{rows_updated_at}` or `{view_last_modified}`. License/terms: `{license_or_terms}`. Attribution link: `{attribution_link}`.",
              "",
              "Leave unavailable fields out instead of inventing values.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerResource(
    "socrata_dataset_metadata",
    new ResourceTemplate("socrata://datasets/{source_id}/metadata", { list: undefined }),
    {
      title: "Socrata Dataset Metadata",
      description:
        "Dataset schema and provenance metadata returned by socrata_describe_dataset.data.",
      mimeType: "application/json",
    },
    async (uri, variables, extra) => {
      const sourceId = getSocrataMetadataSourceId(variables.source_id);
      const result = await describeSocrataDataset({ source_id: sourceId }, config, {
        signal: extra.signal,
      });

      // Resources expose the metadata artifact itself, not the tool-call envelope.
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result.data),
          },
        ],
      };
    },
  );

  server.registerResource(
    "about",
    "catalunya-opendata://about",
    {
      title: "About Catalunya Open Data MCP",
      description: "Basic metadata for this MCP server.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: [
            "# Catalunya Open Data MCP",
            "",
            "MCP server for discovering, describing, and querying Catalunya open data.",
            "",
            "Current Socrata support covers catalog search, dataset metadata, and row queries. Next steps will add source adapters for IDESCAT, Barcelona Open Data, and geospatial services.",
          ].join("\n"),
        },
      ],
    }),
  );

  return server;
}

function getSocrataMetadataSourceId(sourceId: string | string[] | undefined): string {
  if (sourceId === undefined) {
    throw new SocrataError("invalid_input", "Missing source_id in Socrata metadata resource URI.");
  }

  if (Array.isArray(sourceId)) {
    throw new SocrataError(
      "invalid_input",
      "Socrata metadata resource URI must include exactly one source_id.",
    );
  }

  return normalizeSourceId(sourceId);
}

const socrataProvenanceBaseOutputSchema = z.object({
  source: z.literal("socrata"),
  source_url: z.string().url(),
  id: z.string(),
  language: z.literal("ca"),
});

const socrataOperationProvenanceOutputSchema = socrataProvenanceBaseOutputSchema.extend({
  last_updated: z.null(),
  license_or_terms: z.null(),
});

const socrataDatasetProvenanceOutputSchema = socrataProvenanceBaseOutputSchema.extend({
  last_updated: z.string().nullable(),
  license_or_terms: z.string().nullable(),
});

const socrataToolErrorOutputSchema = z.object({
  source: z.literal("socrata"),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  status: z.number().int().optional(),
});

const socrataDatasetCardOutputSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  source_id: z.string(),
  source_domain: z.string(),
  api_endpoint: z.string().url(),
  web_url: z.string().url(),
  updated_at: z.string(),
  provenance: socrataDatasetProvenanceOutputSchema,
});

const socrataSearchDatasetsOutputSchema = z.object({
  data: z
    .object({
      query: z.string(),
      limit: z.number().int().min(1),
      offset: z.number().int().min(0),
      total: z.number().int().nonnegative(),
      results: z.array(socrataDatasetCardOutputSchema),
    })
    .nullable(),
  provenance: socrataOperationProvenanceOutputSchema,
  error: socrataToolErrorOutputSchema.optional(),
});

const socrataDatasetColumnOutputSchema = z.object({
  display_name: z.string(),
  field_name: z.string(),
  datatype: z.string(),
  description: z.string().nullable(),
});

const socrataDescribeDatasetOutputSchema = z.object({
  data: z
    .object({
      title: z.string(),
      description: z.string().nullable(),
      attribution: z.string().nullable(),
      attribution_link: z.string().nullable(),
      license_or_terms: z.string().nullable(),
      category: z.string().nullable(),
      source_id: z.string(),
      source_domain: z.string(),
      api_endpoint: z.string().url(),
      web_url: z.string().url(),
      created_at: z.string().nullable(),
      published_at: z.string().nullable(),
      rows_updated_at: z.string().nullable(),
      view_last_modified: z.string().nullable(),
      columns: z.array(socrataDatasetColumnOutputSchema),
      suggested_next_action: z.string(),
      provenance: socrataDatasetProvenanceOutputSchema,
    })
    .nullable(),
  provenance: socrataOperationProvenanceOutputSchema,
  error: socrataToolErrorOutputSchema.optional(),
});

const socrataQueryDatasetOutputSchema = z.object({
  data: z
    .object({
      source_id: z.string(),
      source_domain: z.string(),
      api_endpoint: z.string().url(),
      request_url: z.string().url(),
      logical_request_url: z.string().url(),
      select: z.string().optional(),
      where: z.string().optional(),
      group: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().int().min(1),
      offset: z.number().int().min(0),
      row_count: z.number().int().nonnegative(),
      truncated: z.boolean(),
      truncation_reason: z.enum(["row_cap", "byte_cap"]).optional(),
      truncation_hint: z.string().optional(),
      rows: z.array(z.record(z.unknown())),
    })
    .nullable(),
  provenance: socrataOperationProvenanceOutputSchema,
  error: socrataToolErrorOutputSchema.optional(),
});

function toSocrataToolError(
  error: unknown,
  fallbackMessage = "Unexpected Socrata search failure.",
): z.infer<typeof socrataToolErrorOutputSchema> {
  if (isSocrataError(error)) {
    return {
      source: "socrata",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }

  return {
    source: "socrata",
    code: "unexpected_error",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: false,
  };
}
