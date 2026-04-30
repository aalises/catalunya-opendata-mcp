import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BCN_RESOURCE_RECOMMENDATION_REGISTRY } from "../dist/sources/bcn/recommend.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({
  name: "catalunya-opendata-mcp-bcn-registry-canary",
  version: packageJson.version,
});

const failures = [];
const summaries = [];

try {
  await client.connect(transport);

  for (const entry of BCN_RESOURCE_RECOMMENDATION_REGISTRY) {
    const info = await callTool("bcn_get_resource_info", {
      resource_id: entry.resourceId,
    });
    const resource = info.data;
    const summary = {
      title: entry.title,
      resource_id: entry.resourceId,
      package_id_match: resource.package_id === entry.packageId,
      registered_format: entry.format,
      live_format: resource.format ?? null,
      registered_datastore_active: entry.datastoreActive,
      live_datastore_active: resource.datastore_active ?? null,
    };
    summaries.push(summary);

    if (!summary.package_id_match) {
      failures.push(
        `${entry.title} (${entry.resourceId}): registry packageId ${entry.packageId} != live ${resource.package_id}`,
      );
    }
    if (
      typeof resource.datastore_active === "boolean" &&
      resource.datastore_active !== entry.datastoreActive
    ) {
      failures.push(
        `${entry.title} (${entry.resourceId}): registry datastoreActive ${entry.datastoreActive} != live ${resource.datastore_active}`,
      );
    }
  }
} finally {
  await client.close();
}

const ok = failures.length === 0;
console.log(
  JSON.stringify(
    {
      ok,
      checked: summaries.length,
      failures,
      summaries,
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exitCode = 1;
}

async function callTool(name, args) {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  if (result.isError) {
    throw new Error(
      `${name} returned an MCP tool error: ${JSON.stringify(result.structuredContent)}`,
    );
  }

  if (!isRecord(result.structuredContent) || !isRecord(result.structuredContent.data)) {
    throw new Error(`${name} returned malformed structuredContent.`);
  }

  return result.structuredContent;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
