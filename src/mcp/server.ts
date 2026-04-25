import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const serverName = "catalunya-opendata-mcp";
export const serverVersion = "0.1.0";

export function createPingMessage(name?: string): string {
  return `Hola${name ? `, ${name}` : ""}. ${serverName} is running.`;
}

export function createMcpServer(): McpServer {
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
            "Barebones MCP server scaffold for Catalonia open data.",
            "",
            "Next steps will add source adapters for Socrata, IDESCAT, Barcelona Open Data, and geospatial services.",
          ].join("\n"),
        },
      ],
    }),
  );

  return server;
}
