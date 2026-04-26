import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const SEARCH_QUERY = "habitatges iniciats acabats";
const SOURCE_ID = "j8h8-vxug";
const INVALID_FIELD = "definitely_not_a_field";
const serverEnv = {
  LOG_LEVEL: "silent",
  ...(process.env.SOCRATA_APP_TOKEN ? { SOCRATA_APP_TOKEN: process.env.SOCRATA_APP_TOKEN } : {}),
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: serverEnv,
});

const client = new Client({
  name: "catalunya-opendata-mcp-socrata-live-canary",
  version: packageJson.version,
});

try {
  await client.connect(transport);

  const search = await callTool("socrata_search_datasets", {
    query: SEARCH_QUERY,
    limit: 10,
  });
  const selectedDataset = search.data.results.find((result) => result.source_id === SOURCE_ID);

  assert(
    selectedDataset !== undefined,
    `Expected Socrata search results for ${JSON.stringify(SEARCH_QUERY)} to include ${SOURCE_ID}.`,
  );

  const describe = await callTool("socrata_describe_dataset", {
    source_id: SOURCE_ID,
  });
  const fieldNames = describe.data.columns
    .map((column) => column.field_name)
    .filter((fieldName) => typeof fieldName === "string" && fieldName.length > 0)
    .slice(0, 2);

  assert(fieldNames.length >= 2, `Expected ${SOURCE_ID} to expose at least two queryable fields.`);

  const query = await callTool("socrata_query_dataset", {
    source_id: SOURCE_ID,
    select: fieldNames.join(", "),
    limit: 3,
  });

  assert(query.data.row_count > 0, "Expected Socrata query to return at least one row.");

  const invalidQuery = await callToolAllowingError("socrata_query_dataset", {
    source_id: SOURCE_ID,
    where: `${INVALID_FIELD} = 'x'`,
    limit: 1,
  });
  const invalidError = invalidQuery.structuredContent?.error;

  assert(invalidQuery.isError === true, "Expected invalid Socrata query to return a tool error.");
  assert(invalidError?.code === "http_error", "Expected invalid Socrata query code http_error.");
  assert(invalidError?.retryable === false, "Expected invalid Socrata query to be non-retryable.");
  assert(invalidError?.status === 400, "Expected invalid Socrata query HTTP status 400.");
  assert(
    typeof invalidError?.message === "string" && invalidError.message.includes(INVALID_FIELD),
    "Expected invalid Socrata query error message to mention the bad field.",
  );

  const summary = {
    ok: true,
    workflow: [
      "socrata_search_datasets",
      "socrata_describe_dataset",
      "socrata_query_dataset",
      "socrata_query_dataset invalid-field recovery",
    ],
    search: {
      query: SEARCH_QUERY,
      total: search.data.total,
      selected: {
        source_id: selectedDataset.source_id,
        title: selectedDataset.title,
        api_endpoint: selectedDataset.api_endpoint,
      },
    },
    describe: {
      title: describe.data.title,
      column_count: describe.data.columns.length,
      selected_fields: fieldNames,
      provenance: describe.data.provenance,
    },
    query: {
      row_count: query.data.row_count,
      truncated: query.data.truncated,
      first_row: query.data.rows[0],
      logical_request_url: query.data.logical_request_url,
      request_url: query.data.request_url,
    },
    invalid_query: {
      code: invalidError.code,
      status: invalidError.status,
      retryable: invalidError.retryable,
      mentions_bad_field: invalidError.message.includes(INVALID_FIELD),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}

async function callTool(name, args) {
  const result = await callToolAllowingError(name, args);

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

async function callToolAllowingError(name, args) {
  return client.callTool({
    name,
    arguments: args,
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
