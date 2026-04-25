import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  createSocrataSearchProvenance,
  searchSocrataDatasets,
} from "../sources/socrata/catalog.js";
import { isSocrataError } from "../sources/socrata/client.js";
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
