#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "catalunya-opendata-mcp",
  version: "0.1.0"
});

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Check that the Catalunya Open Data MCP server is running.",
    inputSchema: {
      name: z.string().optional().describe("Optional name to include in the response.")
    },
    outputSchema: {
      message: z.string(),
      server: z.string()
    }
  },
  async ({ name }) => {
    const message = `Hola${name ? `, ${name}` : ""}. catalunya-opendata-mcp is running.`;

    return {
      content: [
        {
          type: "text",
          text: message
        }
      ],
      structuredContent: {
        message,
        server: "catalunya-opendata-mcp"
      }
    };
  }
);

server.registerResource(
  "about",
  "catalunya-opendata://about",
  {
    title: "About Catalunya Open Data MCP",
    description: "Basic metadata for this MCP server.",
    mimeType: "text/markdown"
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
          "Next steps will add source adapters for Socrata, IDESCAT, Barcelona Open Data, and geospatial services."
        ].join("\n")
      }
    ]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
