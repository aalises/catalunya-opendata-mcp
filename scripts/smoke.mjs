import { readdirSync, readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Plan-mandated guards for generated search-index output. Run before connecting
// to the server so a build that leaks oversized generated files fails fast.
const SEARCH_INDEX_DECL_MAX_BYTES = 32 * 1024;
const SEARCH_INDEX_SOURCE_MAX_BYTES = 1024 * 1024;
const distSearchIndexDir = new URL("../dist/sources/idescat/search-index/", import.meta.url);
const srcSearchIndexDir = new URL("../src/sources/idescat/search-index/", import.meta.url);

const caDeclPath = new URL("ca.d.ts", distSearchIndexDir);
const caDeclSize = statSync(caDeclPath).size;
if (caDeclSize > SEARCH_INDEX_DECL_MAX_BYTES) {
  throw new Error(
    `dist/sources/idescat/search-index/ca.d.ts is ${caDeclSize} bytes, exceeds ${SEARCH_INDEX_DECL_MAX_BYTES}.`,
  );
}

for (const entry of readdirSync(srcSearchIndexDir)) {
  if (!entry.endsWith(".ts")) continue;
  const path = new URL(entry, srcSearchIndexDir);
  const size = statSync(path).size;
  if (size > SEARCH_INDEX_SOURCE_MAX_BYTES) {
    throw new Error(
      `src/sources/idescat/search-index/${entry} is ${size} bytes, exceeds ${SEARCH_INDEX_SOURCE_MAX_BYTES}. Switch to per-statistic sharding.`,
    );
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({
  name: "catalunya-opendata-mcp-smoke-test",
  version: packageJson.version,
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
  if (!tools.tools.some((tool) => tool.name === "socrata_describe_dataset")) {
    throw new Error("Expected socrata_describe_dataset tool to be registered.");
  }
  if (!tools.tools.some((tool) => tool.name === "socrata_query_dataset")) {
    throw new Error("Expected socrata_query_dataset tool to be registered.");
  }
  for (const toolName of [
    "idescat_search_tables",
    "idescat_list_statistics",
    "idescat_list_nodes",
    "idescat_list_tables",
    "idescat_list_table_geos",
    "idescat_get_table_metadata",
    "idescat_get_table_data",
  ]) {
    if (!tools.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`Expected ${toolName} tool to be registered.`);
    }
  }

  const prompts = await client.listPrompts();
  for (const promptName of ["idescat_query_workflow", "idescat_citation"]) {
    if (!prompts.prompts.some((prompt) => prompt.name === promptName)) {
      throw new Error(`Expected ${promptName} prompt to be registered.`);
    }
  }

  const templates = await client.listResourceTemplates();
  if (!templates.resourceTemplates.some((template) => template.name === "idescat_table_metadata")) {
    throw new Error("Expected idescat_table_metadata resource template to be registered.");
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
