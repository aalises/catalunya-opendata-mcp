import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_REQUEST_TIMEOUT_MS = "60000";
const VALID_PROFILES = new Set(["canary", "stress"]);
const PROFILE_CASE_COUNTS = {
  canary: {
    mcp: 1,
    socrata: 4,
    idescat: 13,
  },
  stress: {
    mcp: 1,
    socrata: 53,
    idescat: 71,
  },
};

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date();
const reportPath =
  options.report ??
  resolve(
    process.cwd(),
    "tmp",
    `mcp-eval-${options.profile}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
  );

const report = {
  generated_at: startedAt.toISOString(),
  profile: options.profile,
  package: {
    name: packageJson.name,
    version: packageJson.version,
  },
  command: {
    server: "node dist/index.js",
    report_path: reportPath,
  },
  cases: [],
};

await run();

async function run() {
  const env = createServerEnv();
  const clientHandle = createClient("catalunya-opendata-mcp-evaluator", env);

  try {
    await clientHandle.client.connect(clientHandle.transport);

    await runCanaryProfile(clientHandle.client);

    if (options.profile === "stress") {
      await runStressProfile(clientHandle.client);
    }
  } finally {
    await clientHandle.client.close();
  }

  if (options.profile === "stress") {
    await runLowCapChecks();
  }

  finalizeReport();
}

async function runCanaryProfile(client) {
  await evaluateTool({
    client,
    id: "mcp.ping",
    connector: "mcp",
    category: "surface",
    tool: "ping",
    args: { name: "Evaluator" },
    expect: ({ result }) =>
      passIf(result?.structuredContent?.server === "catalunya-opendata-mcp", "server is running"),
  });

  await evaluateTool({
    client,
    id: "socrata.catalog.search.housing",
    connector: "socrata",
    category: "discovery",
    tool: "socrata_search_datasets",
    args: { query: "habitatges iniciats acabats", limit: 10 },
    expect: ({ data }) =>
      passIf(
        data.results?.some((result) => result.source_id === "j8h8-vxug"),
        "housing search includes j8h8-vxug",
      ),
  });

  await evaluateTool({
    client,
    id: "socrata.dataset.describe.housing",
    connector: "socrata",
    category: "metadata",
    tool: "socrata_describe_dataset",
    args: { source_id: "j8h8-vxug" },
    expect: ({ data }) =>
      passIf(
        data.columns?.length >= 20 &&
          data.columns.some((column) => column.field_name === "municipi"),
        "housing dataset exposes expected queryable fields",
      ),
  });

  await evaluateTool({
    client,
    id: "socrata.query.selected_fields",
    connector: "socrata",
    category: "query",
    tool: "socrata_query_dataset",
    args: {
      source_id: "j8h8-vxug",
      select: "codi_idescat, codi_ine",
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.row_count === 3 &&
          data.truncated === true &&
          data.rows?.[0]?.codi_idescat !== undefined &&
          data.rows?.[0]?.codi_ine !== undefined,
        "selected field query returns bounded rows",
      ),
  });

  await evaluateTool({
    client,
    id: "socrata.query.invalid_field",
    connector: "socrata",
    category: "error",
    tool: "socrata_query_dataset",
    args: {
      source_id: "j8h8-vxug",
      where: "definitely_not_a_field = 'x'",
      limit: 1,
    },
    expect: expectToolError({
      code: "http_error",
      status: 400,
      messageIncludes: "definitely_not_a_field",
    }),
  });

  await evaluateTool({
    client,
    id: "idescat.search.population_age",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_search_tables",
    args: { query: "poblacio sexe edat", lang: "ca", limit: 5 },
    expect: ({ data }) =>
      passIf(
        data.results?.[0]?.statistics_id === "pmh" &&
          data.results?.[0]?.node_id === "1180" &&
          data.results?.[0]?.table_id === "8078",
        "population search resolves PMH population-by-age table",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.geos.population_age",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_list_table_geos",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      lang: "ca",
      limit: 20,
    },
    expect: ({ data }) =>
      passIf(
        data.items?.some((item) => item.geo_id === "cat") &&
          data.items?.some((item) => item.geo_id === "mun"),
        "population table exposes Catalonia and municipality geographies",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.metadata.population_cat",
    connector: "idescat",
    category: "metadata",
    tool: "idescat_get_table_metadata",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "cat",
      lang: "ca",
    },
    expect: ({ data }) =>
      passIf(
        data.dimensions?.some((dimension) => dimension.id === "YEAR") &&
          data.dimensions?.some((dimension) => dimension.id === "CAT"),
        "Catalonia metadata exposes YEAR and CAT dimensions",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.data.population_cat_latest_total",
    connector: "idescat",
    category: "query",
    tool: "idescat_get_table_data",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "cat",
      lang: "ca",
      filters: {
        CAT: "TOTAL",
        AGE: "TOTAL",
        SEX: "TOTAL",
        CONCEPT: "POP",
      },
      last: 1,
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        isGetOnlyData(data) &&
          data.selected_cell_count === 1 &&
          data.row_count === 1 &&
          data.rows?.[0]?.dimensions?.CAT?.label === "Catalunya",
        "latest Catalonia total population returns one GET-backed cell",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.metadata.population_mun",
    connector: "idescat",
    category: "metadata",
    tool: "idescat_get_table_metadata",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "mun",
      lang: "ca",
    },
    expect: ({ data }) => {
      const municipalities = getDimensionCategories(data, "MUN");
      return passIf(municipalities.length >= 250, "municipality metadata exposes >=250 IDs");
    },
  });

  await evaluateTool({
    client,
    id: "idescat.data.population_mun_long_filter_250",
    connector: "idescat",
    category: "regression",
    tool: "idescat_get_table_data",
    args: async () => ({
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "mun",
      lang: "ca",
      filters: {
        MUN: await getMunicipalityIds(client, 250),
        AGE: "TOTAL",
        SEX: "TOTAL",
        CONCEPT: "POP",
      },
      last: 1,
      limit: 3,
    }),
    expect: ({ data }) =>
      passIf(
        isGetOnlyData(data) &&
          data.selected_cell_count === 250 &&
          data.row_count === 3 &&
          data.truncated === true,
        "250-municipality filter stays GET and selects exactly 250 cells",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.search.population_county_geo",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_search_tables",
    args: { query: "poblacio comarca", lang: "ca", limit: 5 },
    expect: ({ data }) =>
      passIf(
        data.results?.[0]?.statistics_id === "pmh" &&
          data.results?.[0]?.geo_candidates?.includes("com"),
        "county population search prefers PMH result with comarca geography",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.data.population_county_total",
    connector: "idescat",
    category: "query",
    tool: "idescat_get_table_data",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "com",
      lang: "ca",
      filters: {
        COM: "TOTAL",
        AGE: "TOTAL",
        SEX: "TOTAL",
        CONCEPT: "POP",
      },
      last: 1,
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        isGetOnlyData(data) &&
          data.selected_cell_count === 1 &&
          data.rows?.[0]?.dimensions?.COM?.label === "Catalunya",
        "county geography total returns one Catalonia row",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.search.income_county",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_search_tables",
    args: { query: "renda comarca", lang: "ca", limit: 5 },
    expect: ({ data }) =>
      passIf(
        data.results?.[0]?.statistics_id === "rfdbc" &&
          data.results?.[0]?.geo_candidates?.includes("com"),
        "county income search resolves RFDBC with comarca geography",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.metadata.income_maresme_guidance",
    connector: "idescat",
    category: "metadata",
    tool: "idescat_get_table_metadata",
    args: {
      statistics_id: "rfdbc",
      node_id: "13301",
      table_id: "14148",
      geo_id: "com",
      lang: "ca",
      place_query: "Maresme",
    },
    expect: ({ data }) =>
      passIf(
        data.filter_guidance?.place_matches?.some((match) => match.category_label === "Maresme") &&
          data.filter_guidance?.recommended_data_call?.filters?.COM === "21",
        "Maresme place guidance recommends COM=21",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.data.income_maresme",
    connector: "idescat",
    category: "query",
    tool: "idescat_get_table_data",
    args: {
      statistics_id: "rfdbc",
      node_id: "13301",
      table_id: "14148",
      geo_id: "com",
      lang: "ca",
      filters: {
        COM: "21",
        CONCEPT: "GROSS_INCOME",
      },
      last: 1,
      limit: 20,
    },
    expect: ({ data }) =>
      passIf(
        isGetOnlyData(data) &&
          data.row_count === 3 &&
          data.rows?.[0]?.dimensions?.COM?.label === "Maresme",
        "Maresme income data returns three indicator rows",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.search.unemployment_alias",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_search_tables",
    args: { query: "taxa atur", lang: "ca", limit: 3 },
    expect: ({ data }) =>
      passIf(data.results?.[0]?.statistics_id === "e03", "taxa atur resolves e03"),
  });

  await evaluateTool({
    client,
    id: "idescat.search.population_age_en",
    connector: "idescat",
    category: "discovery",
    tool: "idescat_search_tables",
    args: { query: "population by age", lang: "en", limit: 3 },
    expect: ({ data }) =>
      passIf(data.results?.[0]?.statistics_id === "pmh", "English population-by-age resolves PMH"),
  });
}

async function runStressProfile(client) {
  await evaluateTool({
    client,
    id: "socrata.resource.metadata.housing",
    connector: "socrata",
    category: "resource",
    resourceUri: "socrata://datasets/j8h8-vxug/metadata",
    expect: ({ resource }) =>
      passIf(
        resource?.source_id === "j8h8-vxug" && Array.isArray(resource.columns),
        "Socrata metadata resource returns dataset metadata",
      ),
  });

  await evaluateTool({
    client,
    id: "socrata.prompt.query_workflow",
    connector: "socrata",
    category: "prompt",
    promptName: "socrata_query_workflow",
    expect: ({ prompt }) => {
      const text = promptText(prompt);
      return passIf(
        text.includes("socrata_search_datasets") &&
          text.includes("socrata_describe_dataset") &&
          text.includes("socrata_query_dataset") &&
          text.includes("field_name"),
        "Socrata query workflow prompt preserves the search -> describe -> query playbook",
      );
    },
  });

  for (const query of [
    "habitatges",
    "qualitat aire",
    "contractes menors",
    "centres educatius",
    "salut hospital",
    "biblioteques",
    "ajuts subvencions",
    "mobilitat transit accidents",
    "meteorologia",
    "turisme",
    "energia",
    "residus",
    "aigua",
    "transport public",
    "mossos",
    "incendis",
    "farmacies",
    "equipaments",
    "pressupost",
    "licitacions",
    "serveis socials",
    "universitats",
    "mapa",
    "poblacio",
  ]) {
    await evaluateTool({
      client,
      id: `socrata.catalog.search.${slug(query)}`,
      connector: "socrata",
      category: "discovery",
      tool: "socrata_search_datasets",
      args: { query, limit: 5 },
      expect: ({ data }) =>
        passIf(
          Number.isInteger(data.total) && data.results?.length <= 5,
          "catalog search returns a bounded page",
        ),
    });
  }

  for (const query of [
    "qwertyuiopasdfghjklzxcvbnm",
    "noexistecapdatasetfoobar987654321",
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  ]) {
    await evaluateTool({
      client,
      id: `socrata.catalog.no_result.${slug(query)}`,
      connector: "socrata",
      category: "discovery",
      tool: "socrata_search_datasets",
      args: { query, limit: 5 },
      expect: ({ data }) => passIf(data.total === 0, "nonsense query returns no results"),
    });
  }

  await evaluateTool({
    client,
    id: "socrata.catalog.pagination.housing",
    connector: "socrata",
    category: "discovery",
    tool: "socrata_search_datasets",
    args: { query: "habitatges", limit: 3, offset: 3 },
    expect: ({ data }) =>
      passIf(data.offset === 3 && data.results?.length <= 3, "catalog offset returns bounded page"),
  });

  await evaluateTool({
    client,
    id: "socrata.catalog.empty_query_schema_error",
    connector: "socrata",
    category: "error",
    tool: "socrata_search_datasets",
    args: { query: "", limit: 5 },
    expect: expectSdkValidationError("query"),
  });

  await evaluateTool({
    client,
    id: "socrata.catalog.limit_schema_error",
    connector: "socrata",
    category: "error",
    tool: "socrata_search_datasets",
    args: { query: "habitatges", limit: 1001 },
    expect: expectSdkValidationError("limit"),
  });

  for (const sourceId of [" j8h8-vxug ", "v8i4-fa4q"]) {
    await evaluateTool({
      client,
      id: `socrata.dataset.describe.${slug(sourceId)}`,
      connector: "socrata",
      category: "metadata",
      tool: "socrata_describe_dataset",
      args: { source_id: sourceId },
      expect: ({ data }) =>
        passIf(
          data.columns?.length > 0 && data.source_id.trim().length === 9,
          "dataset describe returns schema",
        ),
    });
  }

  await evaluateTool({
    client,
    id: "socrata.dataset.describe.invalid_id",
    connector: "socrata",
    category: "error",
    tool: "socrata_describe_dataset",
    args: { source_id: "bad/id" },
    expect: expectToolError({ code: "invalid_input" }),
  });

  await evaluateTool({
    client,
    id: "socrata.dataset.describe.missing_id",
    connector: "socrata",
    category: "error",
    tool: "socrata_describe_dataset",
    args: { source_id: "xxxx-yyyy" },
    expect: expectToolError({ code: "http_error", status: 404 }),
  });

  for (const [id, args, validate] of [
    [
      "socrata.query.pagination_offset",
      {
        source_id: "j8h8-vxug",
        select: "codi_idescat, municipi, any",
        order: "codi_idescat, any",
        limit: 2,
        offset: 2,
      },
      (data) => data.offset === 2 && data.row_count === 2,
    ],
    [
      "socrata.query.girona_2024",
      {
        source_id: "j8h8-vxug",
        select: "municipi, any, iniciats_anuals",
        where: "municipi = 'Girona' AND any = 2024",
        order: "any DESC",
        limit: 5,
      },
      (data) => data.rows?.[0]?.municipi === "Girona",
    ],
    [
      "socrata.query.barcelona_2024",
      {
        source_id: "j8h8-vxug",
        select: "municipi, any, iniciats_anuals",
        where: "municipi = 'Barcelona' AND any = 2024",
        order: "any DESC",
        limit: 5,
      },
      (data) => data.rows?.[0]?.municipi === "Barcelona",
    ],
    [
      "socrata.query.maresme_aggregate",
      {
        source_id: "j8h8-vxug",
        select: "comarca_2023, sum(iniciats_anuals) as total_iniciats",
        where: "comarca_2023 = 'Maresme'",
        group: "comarca_2023",
        limit: 5,
      },
      (data) => data.rows?.[0]?.total_iniciats !== undefined,
    ],
    [
      "socrata.query.year_aggregate",
      {
        source_id: "j8h8-vxug",
        select: "comarca_2023, sum(iniciats_anuals) as total_iniciats",
        where: "any = 2024",
        group: "comarca_2023",
        order: "total_iniciats DESC",
        limit: 5,
      },
      (data) => data.rows?.[0]?.total_iniciats !== undefined,
    ],
    [
      "socrata.query.count_all",
      { source_id: "j8h8-vxug", select: "count(*) as total", limit: 1 },
      (data) => Number(data.rows?.[0]?.total) > 0,
    ],
    [
      "socrata.query.count_2024",
      {
        source_id: "j8h8-vxug",
        select: "count(*) as total",
        where: "any = 2024",
        limit: 1,
      },
      (data) => Number(data.rows?.[0]?.total) > 0,
    ],
  ]) {
    await evaluateTool({
      client,
      id,
      connector: "socrata",
      category: "query",
      tool: "socrata_query_dataset",
      args,
      expect: ({ data }) => passIf(validate(data), `${id} passed`),
    });
  }

  for (const [id, args, expected] of [
    [
      "socrata.query.bad_url_fragment_where",
      { source_id: "j8h8-vxug", where: "?$where=municipi = 'Girona'", limit: 1 },
      { code: "http_error", status: 400 },
    ],
    [
      "socrata.query.negative_offset",
      { source_id: "j8h8-vxug", offset: -1, limit: 1 },
      { code: "invalid_input" },
    ],
    [
      "socrata.query.limit_above_max",
      { source_id: "j8h8-vxug", limit: 101 },
      { code: "invalid_input" },
    ],
    [
      "socrata.query.clause_cap",
      { source_id: "j8h8-vxug", where: "x".repeat(4097), limit: 1 },
      { code: "invalid_input" },
    ],
    [
      "socrata.query.url_cap",
      { source_id: "j8h8-vxug", select: "s".repeat(4096), where: "w".repeat(4096), limit: 1 },
      { code: "invalid_input" },
    ],
  ]) {
    await evaluateTool({
      client,
      id,
      connector: "socrata",
      category: "error",
      tool: "socrata_query_dataset",
      args,
      expect: expectToolError(expected),
    });
  }

  for (const [query, lang] of [
    ["fecunditat", "ca"],
    ["esperanca vida", "ca"],
    ["migracions", "ca"],
    ["llengua catalana", "ca"],
    ["turisme", "ca"],
    ["comerc exterior", "ca"],
    ["ensenyament", "ca"],
    ["universitat", "ca"],
    ["industria", "ca"],
    ["energia", "ca"],
    ["atur comarca", "ca"],
    ["afiliats municipi", "ca"],
    ["renta comarca", "es"],
    ["poblacion edad", "es"],
    ["unemployment rate", "en"],
    ["gross domestic product county", "en"],
    ["population county Girona", "en"],
    ["income Maresme", "en"],
    ["naixements maresme", "ca"],
    ["qwertyuiopasdfghjkl", "ca"],
  ]) {
    await evaluateTool({
      client,
      id: `idescat.search.${slug(query)}.${lang}`,
      connector: "idescat",
      category: "discovery",
      tool: "idescat_search_tables",
      args: { query, lang, limit: 5 },
      expect: ({ data }) =>
        passIf(Number.isInteger(data.total), "search returns a valid result count"),
    });
  }

  await evaluateTool({
    client,
    id: "idescat.search.empty_query_schema_error",
    connector: "idescat",
    category: "error",
    tool: "idescat_search_tables",
    args: { query: "", lang: "ca", limit: 5 },
    expect: expectSdkValidationError("query"),
  });

  await evaluateTool({
    client,
    id: "idescat.search.limit_cap",
    connector: "idescat",
    category: "error",
    tool: "idescat_search_tables",
    args: { query: "poblacio", lang: "ca", limit: 101 },
    expect: expectToolError({ code: "invalid_input" }),
  });

  for (const args of [
    { lang: "ca", limit: 10 },
    { lang: "ca", limit: 5, offset: 5 },
    { lang: "en", limit: 5 },
    { lang: "es", limit: 5 },
  ]) {
    await evaluateTool({
      client,
      id: `idescat.list_statistics.${slug(JSON.stringify(args))}`,
      connector: "idescat",
      category: "browse",
      tool: "idescat_list_statistics",
      args,
      expect: ({ data }) => passIf(data.items?.length > 0, "statistics browse returns items"),
    });
  }

  for (const statisticsId of ["pmh", "rfdbc", "pibc", "covid"]) {
    await evaluateTool({
      client,
      id: `idescat.list_nodes.${statisticsId}`,
      connector: "idescat",
      category: "browse",
      tool: "idescat_list_nodes",
      args: { statistics_id: statisticsId, lang: "ca", limit: 10 },
      expect: ({ data }) => passIf(data.total > 0, "node browse returns items"),
    });
  }

  for (const [id, tool, args, validate] of [
    [
      "idescat.list_tables.pmh_1180",
      "idescat_list_tables",
      { statistics_id: "pmh", node_id: "1180", lang: "ca", limit: 10 },
      (data) => data.items?.some((item) => item.table_id === "8078"),
    ],
    [
      "idescat.list_tables.rfdbc_13301",
      "idescat_list_tables",
      { statistics_id: "rfdbc", node_id: "13301", lang: "ca", limit: 10 },
      (data) => data.items?.some((item) => item.table_id === "14148"),
    ],
    [
      "idescat.list_geos.pmh_8078",
      "idescat_list_table_geos",
      { statistics_id: "pmh", node_id: "1180", table_id: "8078", lang: "ca", limit: 20 },
      (data) => data.items?.some((item) => item.geo_id === "mun"),
    ],
    [
      "idescat.list_geos.rfdbc_14148",
      "idescat_list_table_geos",
      { statistics_id: "rfdbc", node_id: "13301", table_id: "14148", lang: "ca", limit: 20 },
      (data) => data.items?.some((item) => item.geo_id === "com"),
    ],
  ]) {
    await evaluateTool({
      client,
      id,
      connector: "idescat",
      category: "browse",
      tool,
      args,
      expect: ({ data }) => passIf(validate(data), `${id} passed`),
    });
  }

  await evaluateTool({
    client,
    id: "idescat.resource.metadata.pmh_cat",
    connector: "idescat",
    category: "resource",
    resourceUri: "idescat://tables/pmh/1180/8078/cat/metadata",
    expect: ({ resource }) =>
      passIf(
        resource?.statistics_id === "pmh" && resource?.geo_id === "cat",
        "IDESCAT metadata resource returns PMH cat metadata",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.prompt.query_workflow",
    connector: "idescat",
    category: "prompt",
    promptName: "idescat_query_workflow",
    expect: ({ prompt }) => {
      const text = promptText(prompt);
      const searchIndex = text.indexOf("idescat_search_tables");
      const geosIndex = text.indexOf("idescat_list_table_geos");
      const metadataIndex = text.indexOf("idescat_get_table_metadata");
      const dataIndex = text.indexOf("idescat_get_table_data");
      return passIf(
        searchIndex >= 0 &&
          geosIndex > searchIndex &&
          metadataIndex > geosIndex &&
          dataIndex > metadataIndex &&
          text.includes("narrow_filters") &&
          text.includes("Filter cap errors"),
        "IDESCAT query workflow prompt preserves ordered discovery -> metadata -> data guidance",
      );
    },
  });

  await evaluateTool({
    client,
    id: "idescat.prompt.citation",
    connector: "idescat",
    category: "prompt",
    promptName: "idescat_citation",
    expect: ({ prompt }) => {
      const text = promptText(prompt);
      return passIf(
        text.includes("idescat_get_table_metadata") &&
          text.includes(
            "idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata",
          ) &&
          text.includes("license_or_terms"),
        "IDESCAT citation prompt points callers at metadata and resource provenance",
      );
    },
  });

  await evaluateTool({
    client,
    id: "idescat.list_tables.pmh_1180_pagination_offset",
    connector: "idescat",
    category: "browse",
    tool: "idescat_list_tables",
    args: { statistics_id: "pmh", node_id: "1180", lang: "ca", limit: 1, offset: 1 },
    expect: ({ data }) =>
      passIf(
        data.offset === 1 && data.items?.length === 1 && data.total > 1,
        "IDESCAT table browse supports stable offset pagination",
      ),
  });

  await evaluateTool({
    client,
    id: "idescat.metadata.population_cat_unresolved_place",
    connector: "idescat",
    category: "metadata",
    tool: "idescat_get_table_metadata",
    args: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "cat",
      lang: "ca",
      place_query: "NotARealCatalunyaPlace",
    },
    expect: ({ data }) =>
      passIf(
        data.filter_guidance?.unresolved_place_terms?.includes("NotARealCatalunyaPlace"),
        "unmatched IDESCAT place guidance reports unresolved terms",
      ),
  });

  const municipalityIds = await getMunicipalityIds(client, 250);
  for (const [count, limit] of [
    [10, 2],
    [50, 2],
    [100, 2],
    [200, 1],
  ]) {
    await evaluateTool({
      client,
      id: `idescat.data.population_mun_long_filter_${count}`,
      connector: "idescat",
      category: "regression",
      tool: "idescat_get_table_data",
      args: {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        filters: {
          MUN: municipalityIds.slice(0, count),
          AGE: "TOTAL",
          SEX: "TOTAL",
          CONCEPT: "POP",
        },
        last: 1,
        limit,
      },
      expect: ({ data }) =>
        passIf(
          isGetOnlyData(data) && data.selected_cell_count === count,
          `${count}-municipality filter stays GET and selects exactly ${count} cells`,
        ),
    });
  }

  for (const [id, args, validate] of [
    [
      "idescat.data.population_cat_latest_two_total",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: { CAT: "TOTAL", AGE: "TOTAL", SEX: "TOTAL", CONCEPT: "POP" },
        last: 2,
        limit: 5,
      },
      (data) => data.selected_cell_count === 2 && data.row_count === 2,
    ],
    [
      "idescat.data.population_cat_two_sexes",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: { CAT: "TOTAL", AGE: "TOTAL", SEX: ["F", "M"], CONCEPT: "POP" },
        last: 1,
        limit: 5,
      },
      (data) => data.selected_cell_count === 2 && data.row_count === 2,
    ],
    [
      "idescat.data.population_mun_girona_total",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        filters: { MUN: "170792", AGE: "TOTAL", SEX: "TOTAL", CONCEPT: "POP" },
        last: 1,
        limit: 20,
      },
      (data) => data.rows?.[0]?.dimensions?.MUN?.label === "Girona",
    ],
    [
      "idescat.data.population_mun_barcelona_total",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        filters: { MUN: "080193", AGE: "TOTAL", SEX: "TOTAL", CONCEPT: "POP" },
        last: 1,
        limit: 20,
      },
      (data) => data.rows?.[0]?.dimensions?.MUN?.label === "Barcelona",
    ],
    [
      "idescat.data.population_mun_girona_row_cap",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        filters: { MUN: "170792" },
        last: 1,
        limit: 5,
      },
      (data) => data.truncated === true && data.truncation_reason === "row_cap",
    ],
  ]) {
    await evaluateTool({
      client,
      id,
      connector: "idescat",
      category: "query",
      tool: "idescat_get_table_data",
      args,
      expect: ({ data }) => passIf(isGetOnlyData(data) && validate(data), `${id} passed`),
    });
  }

  for (const [id, tool, args, expected] of [
    [
      "idescat.data.population_mun_unfiltered_narrow_filters",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        last: 1,
        limit: 5,
      },
      { code: "narrow_filters" },
    ],
    [
      "idescat.metadata.invalid_path",
      "idescat_get_table_metadata",
      {
        statistics_id: "pmh/evil",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
      },
      { code: "invalid_input" },
    ],
    [
      "idescat.data.reserved_filter",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: { lang: "en" },
        limit: 1,
      },
      { code: "invalid_input" },
    ],
    [
      "idescat.data.last_zero",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        last: 0,
        limit: 1,
      },
      { code: "invalid_input" },
    ],
    [
      "idescat.data.limit_over_max",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        limit: 101,
      },
      { code: "invalid_input" },
    ],
    [
      "idescat.data.filter_count_cap",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`F${index}`, "x"])),
        limit: 1,
      },
      { code: "invalid_input", sourceRule: "filter_count" },
    ],
    [
      "idescat.data.filter_value_byte_cap",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: { CAT: "x".repeat(257) },
        limit: 1,
      },
      { code: "invalid_input", sourceRule: "filter_value_bytes" },
    ],
    [
      "idescat.data.filter_total_byte_cap",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "cat",
        lang: "ca",
        filters: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`F${index}`, "x".repeat(220)]),
        ),
        limit: 1,
      },
      { code: "invalid_input", sourceRule: "filter_total_bytes" },
    ],
    [
      "idescat.data.logical_url_byte_cap",
      "idescat_get_table_data",
      {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "com",
        lang: "ca",
        filters: { COM: Array(15).fill("é".repeat(128)) },
        limit: 1,
      },
      { code: "invalid_input", sourceRule: "logical_url_bytes" },
    ],
  ]) {
    await evaluateTool({
      client,
      id,
      connector: "idescat",
      category: "error",
      tool,
      args,
      expect: expectToolError(expected),
    });
  }
}

async function runLowCapChecks() {
  const lowCapEnv = {
    ...createServerEnv(),
    CATALUNYA_MCP_RESPONSE_MAX_BYTES: "65536",
  };
  const handle = createClient("catalunya-opendata-mcp-evaluator-low-cap", lowCapEnv);

  try {
    await handle.client.connect(handle.transport);

    await evaluateTool({
      client: handle.client,
      id: "idescat.metadata.low_cap_degradation",
      connector: "idescat",
      category: "cap",
      tool: "idescat_get_table_metadata",
      args: {
        statistics_id: "pmh",
        node_id: "1180",
        table_id: "8078",
        geo_id: "mun",
        lang: "ca",
        place_query: "Girona",
      },
      expect: ({ data }) =>
        passIf(
          data.degradation?.dropped?.includes("categories_for_dimensions"),
          "low response cap triggers metadata category degradation",
        ),
    });

    await evaluateTool({
      client: handle.client,
      id: "socrata.query.low_cap_byte_truncation",
      connector: "socrata",
      category: "cap",
      tool: "socrata_query_dataset",
      args: { source_id: "j8h8-vxug", limit: 100 },
      expect: ({ data }) =>
        passIf(
          data.truncated === true && data.truncation_reason === "byte_cap",
          "low response cap triggers Socrata byte truncation",
        ),
    });
  } finally {
    await handle.client.close();
  }
}

async function evaluateTool(caseDef) {
  const sequence = report.cases.length + 1;
  const startedAtMs = performance.now();
  let result;
  let thrown;
  let args;
  let prompt;
  let resource;
  let resourceTextBytes;

  try {
    if (caseDef.resourceUri) {
      result = await caseDef.client.readResource({ uri: caseDef.resourceUri });
      const text = result.contents?.[0]?.text;
      resourceTextBytes = typeof text === "string" ? Buffer.byteLength(text) : undefined;
      resource = typeof text === "string" ? parseJsonSafely(text) : undefined;
    } else if (caseDef.promptName) {
      args = typeof caseDef.args === "function" ? await caseDef.args() : caseDef.args;
      prompt = await caseDef.client.getPrompt({
        name: caseDef.promptName,
        arguments: args,
      });
    } else {
      args = typeof caseDef.args === "function" ? await caseDef.args() : caseDef.args;
      result = await caseDef.client.callTool({
        name: caseDef.tool,
        arguments: args,
      });
    }
  } catch (error) {
    thrown = error;
  }

  const structuredContent = result?.structuredContent;
  const data = isRecord(structuredContent) ? structuredContent.data : undefined;
  const error = isRecord(structuredContent) ? structuredContent.error : undefined;
  const expectation = caseDef.expect({
    args,
    data,
    error,
    prompt,
    resource,
    result,
    structuredContent,
    thrown,
  });
  const passed = expectation.score === 1;
  const entry = {
    sequence,
    id: caseDef.id,
    connector: caseDef.connector,
    category: caseDef.category,
    kind: caseDef.resourceUri ? "resource" : caseDef.promptName ? "prompt" : "tool",
    ...(caseDef.resourceUri
      ? { uri: caseDef.resourceUri }
      : caseDef.promptName
        ? { prompt: caseDef.promptName, args }
        : { tool: caseDef.tool, args }),
    passed,
    score: expectation.score,
    reason: expectation.reason,
    duration_ms: Math.round(performance.now() - startedAtMs),
    status: thrown ? "thrown" : result?.isError ? "tool_error" : "ok",
    summary: summarizeResult({
      data,
      error,
      resource,
      resourceTextBytes,
      result,
      thrown,
      prompt,
    }),
  };

  report.cases.push(entry);

  if (!options.quiet || !passed) {
    const label = caseDef.resourceUri ?? caseDef.promptName ?? caseDef.tool;
    console.log(
      `${String(sequence).padStart(3, "0")} ${passed ? "PASS" : "FAIL"} ${caseDef.connector} ${
        caseDef.category
      } ${label} :: ${caseDef.id}`,
    );
    if (!passed) {
      console.log(JSON.stringify(entry.summary, null, 2));
    }
  }

  if (!passed && options.failFast) {
    throw new Error(`Evaluation failed: ${caseDef.id}: ${expectation.reason}`);
  }

  return entry;
}

function finalizeReport() {
  const endedAt = new Date();
  const failed = report.cases.filter((entry) => !entry.passed);
  const expectedCounts = getExpectedCounts(options.profile);
  const actualCounts = countByConnector(report.cases);
  const countFailures = Object.entries(expectedCounts).flatMap(([connector, expected]) => {
    const actual = actualCounts[connector] ?? 0;
    return actual === expected
      ? []
      : [
          {
            connector,
            expected,
            actual,
          },
        ];
  });

  report.completed_at = endedAt.toISOString();
  report.duration_ms = endedAt.getTime() - startedAt.getTime();
  report.summary = {
    total_cases: report.cases.length,
    passed_cases: report.cases.length - failed.length,
    failed_cases: failed.length,
    score:
      report.cases.length === 0 ? 0 : (report.cases.length - failed.length) / report.cases.length,
    by_connector: Object.fromEntries(
      Object.entries(actualCounts).map(([connector, total]) => {
        const failedForConnector = report.cases.filter(
          (entry) => entry.connector === connector && !entry.passed,
        ).length;
        return [
          connector,
          {
            total,
            passed: total - failedForConnector,
            failed: failedForConnector,
          },
        ];
      }),
    ),
    expected_counts: expectedCounts,
    count_failures: countFailures,
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0 && countFailures.length === 0,
        profile: options.profile,
        reportPath,
        summary: report.summary,
        failures: failed.map((entry) => ({
          id: entry.id,
          reason: entry.reason,
          summary: entry.summary,
        })),
      },
      null,
      2,
    ),
  );

  if (failed.length > 0 || countFailures.length > 0) {
    process.exitCode = 1;
  }
}

function getExpectedCounts(profile) {
  if (profile === "canary") {
    return PROFILE_CASE_COUNTS.canary;
  }

  return {
    mcp: PROFILE_CASE_COUNTS.stress.mcp,
    socrata: PROFILE_CASE_COUNTS.stress.socrata,
    idescat: PROFILE_CASE_COUNTS.stress.idescat,
  };
}

function countByConnector(cases) {
  const counts = {};

  for (const entry of cases) {
    counts[entry.connector] = (counts[entry.connector] ?? 0) + 1;
  }

  return counts;
}

function createClient(name, env) {
  return {
    client: new Client({
      name,
      version: packageJson.version,
    }),
    transport: new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env,
    }),
  };
}

function createServerEnv() {
  return {
    LOG_LEVEL: "silent",
    CATALUNYA_MCP_REQUEST_TIMEOUT_MS:
      process.env.CATALUNYA_MCP_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(process.env.SOCRATA_APP_TOKEN ? { SOCRATA_APP_TOKEN: process.env.SOCRATA_APP_TOKEN } : {}),
  };
}

async function getMunicipalityIds(client, count) {
  const metadata = await client.callTool({
    name: "idescat_get_table_metadata",
    arguments: {
      statistics_id: "pmh",
      node_id: "1180",
      table_id: "8078",
      geo_id: "mun",
      lang: "ca",
    },
  });
  const categories = getDimensionCategories(metadata.structuredContent?.data, "MUN")
    .map((category) => category.id)
    .filter((id) => id !== "TOTAL")
    .slice(0, count);

  if (categories.length !== count) {
    throw new Error(`Expected ${count} municipality IDs, got ${categories.length}.`);
  }

  return categories;
}

function getDimensionCategories(data, dimensionId) {
  if (!isRecord(data) || !Array.isArray(data.dimensions)) {
    return [];
  }

  const dimension = data.dimensions.find((item) => item.id === dimensionId);
  return Array.isArray(dimension?.categories) ? dimension.categories : [];
}

function passIf(condition, reason) {
  return {
    score: condition ? 1 : 0,
    reason,
  };
}

function expectToolError(expected) {
  return ({ error, result }) => {
    if (!isRecord(error) || result?.isError !== true) {
      return {
        score: 0,
        reason: "expected structured tool error",
      };
    }

    if (expected.code !== undefined && error.code !== expected.code) {
      return {
        score: 0,
        reason: `expected error code ${expected.code}, got ${String(error.code)}`,
      };
    }

    if (expected.status !== undefined && error.status !== expected.status) {
      return {
        score: 0,
        reason: `expected error status ${expected.status}, got ${String(error.status)}`,
      };
    }

    if (expected.sourceRule !== undefined && error.source_error?.rule !== expected.sourceRule) {
      return {
        score: 0,
        reason: `expected source_error.rule ${expected.sourceRule}, got ${String(
          error.source_error?.rule,
        )}`,
      };
    }

    if (
      expected.messageIncludes !== undefined &&
      !String(error.message).includes(expected.messageIncludes)
    ) {
      return {
        score: 0,
        reason: `expected error message to include ${expected.messageIncludes}`,
      };
    }

    return {
      score: 1,
      reason: `got expected ${expected.code ?? expected.sourceRule ?? "tool"} error`,
    };
  };
}

function expectSdkValidationError(text) {
  return ({ result, structuredContent, thrown }) => {
    const message = textOf(result);
    return passIf(
      !thrown &&
        result?.isError === true &&
        structuredContent === undefined &&
        message.includes("Input validation error") &&
        message.includes(text),
      `SDK validation error mentions ${text}`,
    );
  };
}

function isGetOnlyData(data) {
  return (
    isRecord(data) &&
    data.request_method === "GET" &&
    data.request_url === data.logical_request_url &&
    !Object.hasOwn(data, "request_body_params")
  );
}

function summarizeResult({ data, error, prompt, resource, resourceTextBytes, result, thrown }) {
  if (thrown) {
    return {
      thrown: {
        code: thrown.code,
        message: String(thrown.message).slice(0, 300),
      },
    };
  }

  if (!isRecord(data) && !isRecord(error) && prompt === undefined && resource === undefined) {
    return {
      mcp_error_text: textOf(result).slice(0, 300) || undefined,
    };
  }

  if (isRecord(error)) {
    return {
      error: {
        code: error.code,
        status: error.status,
        retryable: error.retryable,
        source_rule: error.source_error?.rule,
        message: String(error.message).slice(0, 240),
      },
    };
  }

  if (resource !== undefined) {
    return {
      resource: {
        bytes: resourceTextBytes,
        title: resource.title,
        source_id: resource.source_id,
        statistics_id: resource.statistics_id,
        geo_id: resource.geo_id,
      },
    };
  }

  if (prompt !== undefined) {
    return {
      prompt: {
        description: prompt.description,
        message_count: prompt.messages?.length,
        text_bytes: Buffer.byteLength(promptText(prompt)),
      },
    };
  }

  if (!isRecord(data)) {
    return { data_type: typeof data };
  }

  if (Array.isArray(data.results)) {
    return {
      total: data.total,
      returned: data.results.length,
      first: data.results[0]
        ? {
            source_id: data.results[0].source_id,
            table_id:
              data.results[0].statistics_id === undefined
                ? undefined
                : `${data.results[0].statistics_id}/${data.results[0].node_id}/${data.results[0].table_id}`,
            title: data.results[0].title ?? data.results[0].label,
          }
        : null,
    };
  }

  if (Array.isArray(data.items)) {
    return {
      total: data.total,
      returned: data.items.length,
      truncated: data.truncated,
      first: data.items[0],
    };
  }

  if (Array.isArray(data.columns)) {
    return {
      source_id: data.source_id,
      title: data.title,
      column_count: data.columns.length,
    };
  }

  if (Array.isArray(data.dimensions)) {
    return {
      title: data.title,
      dimensions: data.dimensions.map((dimension) => ({
        id: dimension.id,
        role: dimension.role,
        size: dimension.size,
        categories: dimension.categories?.length,
        categories_omitted: dimension.categories_omitted,
      })),
      degradation: data.degradation,
      place_matches: data.filter_guidance?.place_matches,
    };
  }

  if (Array.isArray(data.rows)) {
    return {
      request_method: data.request_method,
      request_url_equals_logical: data.request_url === data.logical_request_url,
      has_request_body_params: Object.hasOwn(data, "request_body_params"),
      selected_cell_count: data.selected_cell_count,
      row_count: data.row_count,
      truncated: data.truncated,
      truncation_reason: data.truncation_reason,
      first_row: data.rows[0],
    };
  }

  return {
    keys: Object.keys(data),
  };
}

function parseArgs(args) {
  const parsed = {
    failFast: false,
    profile: "canary",
    quiet: false,
    report: undefined,
  };

  for (const arg of args) {
    if (arg === "--fail-fast") {
      parsed.failFast = true;
      continue;
    }

    if (arg === "--quiet") {
      parsed.quiet = true;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      parsed.profile = arg.slice("--profile=".length);
      continue;
    }

    if (arg.startsWith("--report=")) {
      parsed.report = resolve(process.cwd(), arg.slice("--report=".length));
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!VALID_PROFILES.has(parsed.profile)) {
    throw new Error(
      `Invalid --profile=${parsed.profile}. Expected one of: ${[...VALID_PROFILES].join(", ")}`,
    );
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/evaluate-mcp.mjs [--profile=canary|stress] [--report=path] [--quiet] [--fail-fast]

Profiles:
  canary  Fast live eval over MCP health, Socrata core path, and IDESCAT core path.
  stress  Full live eval over search, metadata, data, resources, caps, and regressions.
`);
  process.exit(0);
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function textOf(result) {
  return Array.isArray(result?.content)
    ? result.content.map((content) => content.text ?? "").join("\n")
    : "";
}

function promptText(prompt) {
  return Array.isArray(prompt?.messages)
    ? prompt.messages
        .map((message) => (message.content?.type === "text" ? message.content.text : ""))
        .join("\n")
    : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
