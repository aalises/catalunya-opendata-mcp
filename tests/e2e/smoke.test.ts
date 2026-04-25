import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { packageVersion } from "../../src/package-info.js";

let client: Client | undefined;

describe("stdio MCP server", () => {
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("registers and calls the ping tool", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
    });

    client = new Client({
      name: "catalunya-opendata-mcp-vitest",
      version: packageVersion,
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("ping");
    expect(tools.tools.map((tool) => tool.name)).toContain("socrata_search_datasets");
    expect(tools.tools.map((tool) => tool.name)).toContain("socrata_describe_dataset");
    expect(tools.tools.map((tool) => tool.name)).toContain("socrata_query_dataset");

    const result = await client.callTool({
      name: "ping",
      arguments: {
        name: "Albert",
      },
    });

    expect(result.structuredContent).toEqual({
      message: "Hola, Albert. catalunya-opendata-mcp is running.",
      server: "catalunya-opendata-mcp",
    });
  });
});
