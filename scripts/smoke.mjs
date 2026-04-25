import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({
  name: "catalunya-opendata-mcp-smoke-test",
  version: "0.1.0",
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "ping")) {
    throw new Error("Expected ping tool to be registered.");
  }
  if (!tools.tools.some((tool) => tool.name === "socrata_search_datasets")) {
    throw new Error("Expected socrata_search_datasets tool to be registered.");
  }

  const result = await client.callTool({
    name: "ping",
    arguments: {
      name: "Albert",
    },
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
