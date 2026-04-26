import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const QUERY = "poblacio sexe edat";
const EXPECTED_STATISTICS_ID = "pmh";
const EXPECTED_NODE_ID = "1180";
const EXPECTED_TABLE_ID = "8078";
const PREFERRED_GEO_ID = "cat";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({
  name: "catalunya-opendata-mcp-idescat-live-canary",
  version: packageJson.version,
});

try {
  await client.connect(transport);

  const search = await callTool("idescat_search_tables", {
    query: QUERY,
    lang: "ca",
    limit: 5,
  });
  const selectedTable = search.data.results[0];

  assert(
    selectedTable?.statistics_id === EXPECTED_STATISTICS_ID &&
      selectedTable.node_id === EXPECTED_NODE_ID &&
      selectedTable.table_id === EXPECTED_TABLE_ID,
    `Expected search top result ${EXPECTED_STATISTICS_ID}/${EXPECTED_NODE_ID}/${EXPECTED_TABLE_ID}, got ${formatTableId(selectedTable)}.`,
  );

  const geos = await callTool("idescat_list_table_geos", {
    statistics_id: selectedTable.statistics_id,
    node_id: selectedTable.node_id,
    table_id: selectedTable.table_id,
    lang: "ca",
    limit: 20,
  });
  const selectedGeo =
    geos.data.items.find((item) => item.geo_id === PREFERRED_GEO_ID) ?? geos.data.items[0];

  assert(selectedGeo !== undefined, "Expected at least one IDESCAT geo candidate.");

  const metadata = await callTool("idescat_get_table_metadata", {
    statistics_id: selectedTable.statistics_id,
    node_id: selectedTable.node_id,
    table_id: selectedTable.table_id,
    geo_id: selectedGeo.geo_id,
    lang: "ca",
  });
  const filters = buildTinyFilters(metadata.data.dimensions);

  assert(Object.keys(filters).length > 0, "Expected metadata dimensions to produce filters.");

  const data = await callTool("idescat_get_table_data", {
    statistics_id: selectedTable.statistics_id,
    node_id: selectedTable.node_id,
    table_id: selectedTable.table_id,
    geo_id: selectedGeo.geo_id,
    lang: "ca",
    filters,
    last: 1,
    limit: 3,
  });

  assert(data.data.row_count > 0, "Expected at least one data row.");
  assert(data.data.rows.length > 0, "Expected returned rows to be non-empty.");

  const summary = {
    ok: true,
    workflow: [
      "idescat_search_tables",
      "idescat_list_table_geos",
      "idescat_get_table_metadata",
      "idescat_get_table_data",
    ],
    search: {
      query: search.data.query,
      total: search.data.total,
      selected: pickTableSummary(selectedTable),
    },
    geos: {
      total: geos.data.total,
      selected: {
        geo_id: selectedGeo.geo_id,
        label: selectedGeo.label,
      },
    },
    metadata: {
      title: metadata.data.title,
      dimensions: metadata.data.dimensions.map((dimension) => ({
        id: dimension.id,
        label: dimension.label,
        role: dimension.role ?? null,
        size: dimension.size,
      })),
    },
    data: {
      filters,
      last: data.data.last ?? 1,
      selected_cell_count: data.data.selected_cell_count,
      row_count: data.data.row_count,
      truncated: data.data.truncated,
      truncation_reason: data.data.truncation_reason ?? null,
      first_row: data.data.rows[0],
    },
    citation: {
      source_url: metadata.data.provenance.source_url,
      last_updated: metadata.data.last_updated ?? metadata.data.provenance.last_updated,
      license_or_terms: metadata.data.provenance.license_or_terms,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
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

function buildTinyFilters(dimensions) {
  const filters = {};

  for (const dimension of dimensions) {
    if (dimension.role === "time") {
      continue;
    }

    const categories = Array.isArray(dimension.categories) ? dimension.categories : [];
    const category =
      categories.find((item) => item.id === "TOTAL") ??
      categories.find((item) => item.id === "POP") ??
      categories[0];

    if (category?.id) {
      filters[dimension.id] = category.id;
    }
  }

  return filters;
}

function pickTableSummary(entry) {
  return {
    statistics_id: entry.statistics_id,
    node_id: entry.node_id,
    table_id: entry.table_id,
    label: entry.label,
  };
}

function formatTableId(entry) {
  if (!entry) {
    return "<none>";
  }

  return `${entry.statistics_id}/${entry.node_id}/${entry.table_id}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
