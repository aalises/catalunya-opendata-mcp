import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { packageVersion } from "../package-info.js";
import { registerSocrataTools } from "./tools/socrata.js";

export const serverName = "catalunya-opendata-mcp";
export const serverVersion = packageVersion;

export function createPingMessage(name?: string): string {
  return `Hola${name ? `, ${name}` : ""}. ${serverName} is running.`;
}

export function createMcpServer(config: AppConfig): McpServer {
  const logger = createLogger(config);
  const server = new McpServer({
    name: serverName,
    version: serverVersion,
  });

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

  registerSocrataTools(server, config, logger.child({ source: "socrata" }));

  return server;
}
