import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_REQUEST_TIMEOUT_MS = "60000";
const VALID_PROFILES = new Set(["canary", "stress"]);
const VALID_MODES = new Set(["live", "record", "replay"]);
const PROFILE_CASE_COUNTS = {
  canary: {
    mcp: 1,
    socrata: 4,
    bcn: 8,
    idescat: 13,
  },
  stress: {
    mcp: 1,
    socrata: 53,
    bcn: 23,
    idescat: 71,
  },
};

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date();
const cassettePath =
  options.cassette ??
  (options.mode === "live"
    ? undefined
    : resolve(process.cwd(), "tests", "fixtures", "evals", `${options.profile}.json`));
const recorder = createMcpRecorder({
  cassettePath,
  mode: options.mode,
  profile: options.profile,
});
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
  evaluation: {
    mode: options.mode,
    cassette_path: cassettePath,
  },
  cases: [],
};

await run();

async function run() {
  const env = createServerEnv();
  const clientHandle = createClient("catalunya-opendata-mcp-evaluator", env, "default");

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
    id: "bcn.catalog.search.piezometres",
    connector: "bcn",
    category: "discovery",
    tool: "bcn_search_packages",
    args: { query: "piezometres equipaments", limit: 5 },
    expect: ({ data }) =>
      passIf(
        data.results?.some(
          (result) => result.package_id === "e7a90d92-abf6-41d4-9310-da8b82b55b49",
        ),
        "BCN package search finds the piezometers equipment package",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.query.piezometres_datastore",
    connector: "bcn",
    category: "query",
    tool: "bcn_query_resource",
    args: {
      resource_id: "52696168-d8bc-4707-9a09-a21c6c2669f3",
      fields: ["_id", "Districte", "Barri"],
      limit: 2,
    },
    expect: ({ data }) =>
      passIf(
        data.request_method === "POST" &&
          data.request_body?.limit === 2 &&
          data.row_count === 2 &&
          data.rows?.[0]?._id !== undefined,
        "BCN active DataStore query returns bounded POST-backed rows",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.query.arbrat_viari_inactive_error",
    connector: "bcn",
    category: "error",
    tool: "bcn_query_resource",
    args: {
      resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      limit: 2,
    },
    expect: expectToolError({
      code: "invalid_input",
      messageIncludes: "bcn_preview_resource",
    }),
  });

  await evaluateTool({
    client,
    id: "bcn.preview.arbrat_viari_csv",
    connector: "bcn",
    category: "preview",
    tool: "bcn_preview_resource",
    args: {
      resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      limit: 2,
    },
    expect: ({ data }) =>
      passIf(
        data.format === "csv" &&
          data.request_method === "GET" &&
          data.row_count > 0 &&
          data.rows?.length <= 2 &&
          data.columns?.length > 0,
        "BCN inactive arbrat-viari CSV resource returns a bounded preview",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.sagrada_familia",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Sagrada Familia",
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.strategy === "datastore" &&
          data.query_variants?.includes("sagrada") &&
          data.candidates?.some(
            (candidate) =>
              typeof candidate.lat === "number" &&
              typeof candidate.lon === "number" &&
              candidate.matched_fields?.some((field) =>
                ["name", "addresses_neighborhood_name"].includes(field),
              ),
          ),
        "BCN place resolver finds Sagrada Familia candidates without external geocoding",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.street_consell_de_cent",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Consell de Cent",
      kinds: ["street"],
      limit: 2,
    },
    expect: ({ data }) =>
      passIf(
        data.query_variants?.includes("consell") &&
          data.candidates?.some(
            (candidate) =>
              candidate.kind === "street" &&
              candidate.name?.toLowerCase().includes("consell") &&
              candidate.source_resource_id === "661fe190-67c8-423a-b8eb-8140f547fde2" &&
              typeof candidate.lat === "number" &&
              typeof candidate.lon === "number",
          ),
        "BCN place resolver resolves street names through the address registry",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.recommend.trees_street",
    connector: "bcn",
    category: "recommend",
    tool: "bcn_recommend_resources",
    args: {
      query: "tree species on Carrer Consell de Cent",
      task: "group",
      place_kind: "street",
      limit: 2,
    },
    expect: ({ data }) =>
      passIf(
        data.recommendations?.[0]?.resource_id === "23124fd5-521f-40f8-85b8-efb1e71c2ec8" &&
          data.recommendations?.[0]?.suggested_tool === "bcn_query_resource_geo" &&
          data.recommendations?.[0]?.example_arguments?.contains?.adreca === "<street name>",
        "BCN recommender suggests street-tree geo grouping for tree species street questions",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.district_gracia_area_ref",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Gracia",
      kinds: ["district"],
      limit: 1,
    },
    expect: ({ data }) =>
      passIf(
        data.candidates?.[0]?.kind === "district" &&
          data.candidates?.[0]?.name === "Gràcia" &&
          typeof data.candidates?.[0]?.area_ref?.row_id !== "undefined" &&
          data.candidates?.[0]?.area_ref?.source_resource_id ===
            "576bc645-9481-4bc4-b8bf-f5972c20df3f" &&
          typeof data.candidates?.[0]?.bbox?.min_lat === "number",
        "BCN place resolver returns reusable area_ref and bbox metadata for districts",
      ),
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
      expectIdescatGetData(data, {
        firstDimensionLabel: ["CAT", "Catalunya"],
        reason: "latest Catalonia total population returns one GET-backed cell",
        rowCount: 1,
        selectedCellCount: 1,
      }),
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
      expectIdescatGetData(data, {
        reason: "250-municipality filter stays GET and selects exactly 250 cells",
        rowCount: 3,
        selectedCellCount: 250,
        truncated: true,
      }),
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
      expectIdescatGetData(data, {
        firstDimensionLabel: ["COM", "Catalunya"],
        reason: "county geography total returns one Catalonia row",
        selectedCellCount: 1,
      }),
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
    id: "bcn.geo.arbrat_consell_species",
    connector: "bcn",
    category: "geo",
    tool: "bcn_query_resource_geo",
    args: {
      resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      contains: {
        adreca: "Carrer Consell de Cent",
      },
      group_by: "cat_nom_catala",
      fields: ["adreca", "cat_nom_catala"],
      limit: 5,
    },
    expect: ({ data }) =>
      passIf(
        data.strategy === "download_stream" &&
          data.coordinate_fields?.lat === "latitud" &&
          data.coordinate_fields?.lon === "longitud" &&
          data.matched_row_count > 0 &&
          data.groups?.some((group) => group.key === "Lledoner" && group.count > 0),
        "BCN geo scan counts street-tree species on Consell de Cent",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.geo.facilities_near_sagrada",
    connector: "bcn",
    category: "geo",
    tool: "bcn_query_resource_geo",
    args: async () => {
      const resolved = await client.callTool({
        name: "bcn_resolve_place",
        arguments: {
          query: "Sagrada Família",
          kinds: ["landmark"],
          limit: 1,
        },
      });
      const candidate = resolved.structuredContent?.data?.candidates?.[0];

      if (!candidate) {
        throw new Error("bcn_resolve_place did not return a Sagrada Família candidate");
      }

      return {
        resource_id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
        near: {
          lat: candidate.lat,
          lon: candidate.lon,
          radius_m: 1_500,
        },
        fields: ["name", "addresses_road_name", "addresses_neighborhood_name"],
        group_by: "addresses_neighborhood_name",
        group_limit: 5,
        limit: 5,
      };
    },
    expect: ({ data }) =>
      passIf(
        data.strategy === "datastore" &&
          data.datastore_mode === "sql" &&
          data.row_count > 0 &&
          typeof data.rows?.[0]?._geo?.distance_m === "number" &&
          data.groups?.some(
            (group) =>
              typeof group.min_distance_m === "number" &&
              group.sample_nearest?._geo?.distance_m === group.min_distance_m,
          ),
        "BCN geo near query uses SQL pushdown and returns nearest group samples",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.geo.facilities_within_gracia",
    connector: "bcn",
    category: "geo",
    tool: "bcn_query_resource_geo",
    args: async () => {
      const resolved = await client.callTool({
        name: "bcn_resolve_place",
        arguments: {
          query: "Gracia",
          kinds: ["district"],
          limit: 1,
        },
      });
      const areaRef = resolved.structuredContent?.data?.candidates?.[0]?.area_ref;

      if (!areaRef) {
        throw new Error("bcn_resolve_place did not return a Gràcia area_ref");
      }

      return {
        resource_id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
        within_place: {
          source_resource_id: areaRef.source_resource_id,
          row_id: areaRef.row_id,
          geometry_field: areaRef.geometry_field,
        },
        fields: [
          "name",
          "addresses_neighborhood_name",
          "addresses_district_name",
          "secondary_filters_name",
        ],
        group_by: "addresses_neighborhood_name",
        group_limit: 5,
        limit: 5,
      };
    },
    expect: ({ data }) =>
      passIf(
        data.strategy === "datastore" &&
          data.datastore_mode === "sql" &&
          data.area_filter?.source_resource_id === "576bc645-9481-4bc4-b8bf-f5972c20df3f" &&
          data.row_count > 0 &&
          data.rows?.every((row) => row.addresses_district_name === "Gràcia") &&
          data.groups?.length > 0,
        "BCN geo query filters facilities inside a resolved district polygon",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.recommend.facilities_area",
    connector: "bcn",
    category: "recommend",
    tool: "bcn_recommend_resources",
    args: {
      query: "facilities in Gracia district",
      task: "within",
      place_kind: "district",
      limit: 2,
    },
    expect: ({ data }) =>
      passIf(
        data.recommendations?.some(
          (recommendation) =>
            recommendation.resource_id === "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7" &&
            recommendation.example_arguments?.within_place,
        ),
        "BCN recommender returns within_place-ready facility resources for area questions",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.city_plan.trees_consell_species",
    connector: "bcn",
    category: "city_query",
    tool: "bcn_plan_query",
    args: {
      query: "tree species on Carrer Consell de Cent",
      limit: 5,
    },
    expect: ({ data }) =>
      passIf(
        data.status === "ready" &&
          data.final_tool === "bcn_query_resource_geo" &&
          data.final_arguments?.contains?.adreca === "Carrer Consell de Cent" &&
          data.final_arguments?.group_by === "cat_nom_catala",
        "BCN city planner produces a street-tree species grouping plan",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.city_execute.facilities_near_sagrada",
    connector: "bcn",
    category: "city_query",
    tool: "bcn_execute_city_query",
    args: {
      query: "facilities near Sagrada Família",
      radius_m: 1_500,
      limit: 5,
    },
    expect: ({ data }) =>
      passIf(
        data.execution_status === "completed" &&
          data.final_tool === "bcn_query_resource_geo" &&
          data.plan?.intent?.spatial_mode === "near" &&
          data.final_result?.data?.strategy === "datastore" &&
          data.final_result?.data?.row_count > 0,
        "BCN city executor resolves a named place and runs a bounded near query",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.city_execute.facilities_within_gracia_grouped",
    connector: "bcn",
    category: "city_query",
    tool: "bcn_execute_city_query",
    args: {
      query: "count facilities in Gràcia by neighborhood",
      limit: 5,
    },
    expect: ({ data }) =>
      passIf(
        data.execution_status === "completed" &&
          data.final_tool === "bcn_query_resource_geo" &&
          data.plan?.intent?.spatial_mode === "within" &&
          data.final_arguments?.within_place?.source_resource_id ===
            "576bc645-9481-4bc4-b8bf-f5972c20df3f" &&
          data.final_result?.data?.groups?.length > 0,
        "BCN city executor resolves a district and runs a grouped within-place query",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.city_plan.unsupported_question",
    connector: "bcn",
    category: "city_query",
    tool: "bcn_plan_query",
    args: {
      query: "interplanetary ferry permits",
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.status === "unsupported" && data.recommendations?.length === 0,
        "BCN city planner does not force unrelated questions into a low-confidence resource",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.park_guell_landmark",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Park Guell",
      kinds: ["landmark"],
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.candidates?.some(
          (candidate) =>
            candidate.kind === "landmark" &&
            candidate.name?.toLowerCase().includes("park") &&
            typeof candidate.lat === "number" &&
            typeof candidate.lon === "number",
        ),
        "BCN place resolver handles accent-insensitive Park Güell lookup",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.placa_catalunya_street",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Plaça Catalunya",
      kinds: ["street"],
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.query_variants?.includes("catalunya") &&
          data.candidates?.[0]?.kind === "street" &&
          data.candidates?.[0]?.name === "Plaça Catalunya" &&
          data.candidates?.[0]?.source_dataset_name === "Open Data BCN building addresses",
        "BCN place resolver resolves Plaça Catalunya through the address registry",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.district_gracia",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Gracia",
      kinds: ["district"],
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.candidates?.[0]?.kind === "district" &&
          data.candidates?.[0]?.name === "Gràcia" &&
          data.candidates?.[0]?.matched_fields?.includes("nom_districte") &&
          typeof data.candidates?.[0]?.lat === "number" &&
          typeof data.candidates?.[0]?.lon === "number",
        "BCN place resolver resolves accentless district names from administrative boundaries",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.neighborhood_sagrada_familia",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "Sagrada Familia",
      kinds: ["neighborhood"],
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.candidates?.[0]?.kind === "neighborhood" &&
          data.candidates?.[0]?.name === "la Sagrada Família" &&
          data.candidates?.[0]?.district === "Eixample" &&
          typeof data.candidates?.[0]?.lat === "number" &&
          typeof data.candidates?.[0]?.lon === "number",
        "BCN place resolver resolves neighborhoods from administrative boundaries",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.place.no_result",
    connector: "bcn",
    category: "place",
    tool: "bcn_resolve_place",
    args: {
      query: "zzzxxy",
      limit: 3,
    },
    expect: ({ data }) =>
      passIf(
        data.candidates?.length === 0 && data.truncated === false,
        "BCN place resolver returns an empty candidate list for nonsense places",
      ),
  });

  await evaluateTool({
    client,
    id: "bcn.geo.explicit_bad_fields",
    connector: "bcn",
    category: "error",
    tool: "bcn_query_resource_geo",
    args: {
      resource_id: "52696168-d8bc-4707-9a09-a21c6c2669f3",
      bbox: {
        min_lat: 41.3,
        min_lon: 2.1,
        max_lat: 41.5,
        max_lon: 2.3,
      },
      lat_field: "missing_lat",
      lon_field: "missing_lon",
      limit: 1,
    },
    expect: expectToolError({
      code: "invalid_input",
      messageIncludes: "lat_field",
    }),
  });

  await evaluateTool({
    client,
    id: "bcn.geo.arbrat_bbox_scan_cap",
    connector: "bcn",
    category: "geo",
    tool: "bcn_query_resource_geo",
    args: {
      resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
      bbox: {
        min_lat: 41.3,
        min_lon: 2.0,
        max_lat: 41.5,
        max_lon: 2.3,
      },
      fields: ["adreca"],
      limit: 1,
    },
    expect: ({ data }) =>
      passIf(
        data.strategy === "download_stream" &&
          data.truncated === true &&
          data.truncation_reason === "scan_cap",
        "BCN broad geo scan reports the configured scan cap",
      ),
  });

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
        expectIdescatGetData(data, {
          reason: `${count}-municipality filter stays GET and selects exactly ${count} cells`,
          selectedCellCount: count,
        }),
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
  const handle = createClient("catalunya-opendata-mcp-evaluator-low-cap", lowCapEnv, "low-cap");

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
  const expectation = normalizeExpectation(
    caseDef.expect({
      args,
      data,
      error,
      prompt,
      resource,
      result,
      structuredContent,
      thrown,
    }),
  );
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
    assertions: expectation.assertions,
    failed_assertions: expectation.assertions.filter((assertion) => !assertion.passed).length,
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

  const ok = failed.length === 0 && countFailures.length === 0;

  if (ok) {
    recorder.save(report.summary);
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok,
        profile: options.profile,
        mode: options.mode,
        cassettePath,
        reportPath,
        summary: report.summary,
        failures: failed.map((entry) => ({
          id: entry.id,
          reason: entry.reason,
          assertions: entry.assertions?.filter((assertion) => !assertion.passed),
          summary: entry.summary,
        })),
      },
      null,
      2,
    ),
  );

  if (!ok) {
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
    bcn: PROFILE_CASE_COUNTS.stress.bcn,
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

function createClient(name, env, scope) {
  if (options.mode === "replay") {
    return {
      client: createRecordedClient(scope),
      transport: undefined,
    };
  }

  const sdkClient = new Client({
    name,
    version: packageJson.version,
  });

  return {
    client: createRecordedClient(scope, sdkClient),
    transport: new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env,
    }),
  };
}

function createRecordedClient(scope, sdkClient) {
  return {
    async callTool(params) {
      return recorder.invoke(scope, "callTool", params, () => sdkClient.callTool(params));
    },
    async close() {
      if (sdkClient !== undefined) {
        await sdkClient.close();
      }
    },
    async connect(transport) {
      if (sdkClient !== undefined) {
        await sdkClient.connect(transport);
      }
    },
    async getPrompt(params) {
      return recorder.invoke(scope, "getPrompt", params, () => sdkClient.getPrompt(params));
    },
    async readResource(params) {
      return recorder.invoke(scope, "readResource", params, () => sdkClient.readResource(params));
    },
  };
}

function createMcpRecorder({ cassettePath, mode, profile }) {
  const interactions = [];
  const byKey = new Map();

  if (mode === "replay") {
    if (cassettePath === undefined || !existsSync(cassettePath)) {
      throw new Error(
        `Replay cassette not found: ${cassettePath ?? "(missing)"}. Run with --mode=record first.`,
      );
    }

    const cassette = JSON.parse(readFileSync(cassettePath, "utf8"));
    for (const interaction of cassette.interactions ?? []) {
      byKey.set(interaction.key, interaction);
    }
  }

  return {
    mode,
    async invoke(scope, method, params, perform) {
      const key = createInteractionKey(scope, method, params);
      const existing = byKey.get(key);

      if (existing !== undefined) {
        if (existing.error !== undefined) {
          throw deserializeRecordedError(existing.error);
        }

        return cloneJson(existing.result);
      }

      if (mode === "replay") {
        throw new Error(
          `Missing replay cassette interaction: ${scope}:${method}:${stableJson(params)}`,
        );
      }

      try {
        const result = await perform();
        const interaction = {
          key,
          scope,
          method,
          params: cloneJson(params),
          recorded_at: new Date().toISOString(),
          result: cloneJson(result),
        };
        interactions.push(interaction);
        byKey.set(key, interaction);
        return result;
      } catch (error) {
        const interaction = {
          key,
          scope,
          method,
          params: cloneJson(params),
          recorded_at: new Date().toISOString(),
          error: serializeRecordedError(error),
        };
        interactions.push(interaction);
        byKey.set(key, interaction);
        throw error;
      }
    },
    save(summary) {
      if (mode !== "record" || cassettePath === undefined) {
        return;
      }

      const cassette = {
        version: 1,
        profile,
        package: {
          name: packageJson.name,
          version: packageJson.version,
        },
        recorded_at: new Date().toISOString(),
        summary,
        interactions,
      };

      mkdirSync(dirname(cassettePath), { recursive: true });
      writeFileSync(cassettePath, `${JSON.stringify(cassette, null, 2)}\n`);
    },
  };
}

function createInteractionKey(scope, method, params) {
  return `${scope}:${method}:${stableJson(params)}`;
}

function stableJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function serializeRecordedError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: String(error?.message ?? error),
  };
}

function deserializeRecordedError(error) {
  const replayError = new Error(error.message);
  replayError.name = error.name ?? "RecordedMcpError";
  replayError.code = error.code;

  return replayError;
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
  return assertAll(reason, [assertThat(reason, condition)]);
}

function expectIdescatGetData(
  data,
  { firstDimensionLabel, reason, rowCount, selectedCellCount, truncated },
) {
  const assertions = [...getOnlyDataAssertions(data)];

  if (selectedCellCount !== undefined) {
    assertions.push(
      assertEqual("selected_cell_count", data?.selected_cell_count, selectedCellCount),
    );
  }

  if (rowCount !== undefined) {
    assertions.push(assertEqual("row_count", data?.row_count, rowCount));
  }

  if (truncated !== undefined) {
    assertions.push(assertEqual("truncated", data?.truncated, truncated));
  }

  if (firstDimensionLabel !== undefined) {
    const [dimensionId, expectedLabel] = firstDimensionLabel;
    assertions.push(
      assertEqual(
        `first row ${dimensionId} label`,
        data?.rows?.[0]?.dimensions?.[dimensionId]?.label,
        expectedLabel,
      ),
    );
  }

  return assertAll(reason, assertions);
}

function getOnlyDataAssertions(data) {
  return [
    assertThat("data is structured object", isRecord(data), {
      actual: data === undefined ? "undefined" : typeof data,
      expected: "object",
    }),
    assertEqual("request_method", data?.request_method, "GET"),
    assertThat(
      "request_url equals logical_request_url",
      data?.request_url === data?.logical_request_url,
      {
        actual: data?.request_url === data?.logical_request_url,
        expected: true,
      },
    ),
    assertThat(
      "request_body_params omitted",
      isRecord(data) && !Object.hasOwn(data, "request_body_params"),
      {
        actual: isRecord(data) && Object.hasOwn(data, "request_body_params") ? "present" : "absent",
        expected: "absent",
      },
    ),
  ];
}

function assertAll(reason, assertions) {
  const normalizedAssertions = assertions.map((assertion) => normalizeAssertion(assertion));
  const failedAssertion = normalizedAssertions.find((assertion) => !assertion.passed);

  return {
    score: failedAssertion === undefined ? 1 : 0,
    reason: failedAssertion === undefined ? reason : `${reason}: ${failedAssertion.name}`,
    assertions: normalizedAssertions,
  };
}

function assertThat(name, condition, details = {}) {
  return {
    name,
    passed: Boolean(condition),
    ...details,
  };
}

function assertEqual(name, actual, expected) {
  return assertThat(name, Object.is(actual, expected), {
    actual,
    expected,
  });
}

function normalizeExpectation(expectation) {
  if (!isRecord(expectation)) {
    return assertAll("expectation returned an invalid result", [
      assertThat("expectation is an object", false, {
        actual: typeof expectation,
        expected: "object",
      }),
    ]);
  }

  const score = expectation.score === 1 ? 1 : 0;
  const assertions = Array.isArray(expectation.assertions)
    ? expectation.assertions.map((assertion) => normalizeAssertion(assertion))
    : [
        normalizeAssertion({
          name: expectation.reason ?? "case expectation",
          passed: score === 1,
        }),
      ];
  const failedAssertion = assertions.find((assertion) => !assertion.passed);

  return {
    score,
    reason:
      expectation.reason ??
      (failedAssertion === undefined ? "expectation passed" : `failed: ${failedAssertion.name}`),
    assertions,
  };
}

function normalizeAssertion(assertion) {
  const assertionObject = isRecord(assertion) ? assertion : {};
  const normalized = {
    name: String(assertionObject.name ?? "unnamed assertion"),
    passed: assertionObject.passed === true,
  };

  if (Object.hasOwn(assertionObject, "expected")) {
    normalized.expected = compactAssertionValue(assertionObject.expected);
  }

  if (Object.hasOwn(assertionObject, "actual")) {
    normalized.actual = compactAssertionValue(assertionObject.actual);
  }

  if (assertionObject.hint !== undefined) {
    normalized.hint = String(assertionObject.hint);
  }

  return normalized;
}

function compactAssertionValue(value) {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.length > 20
      ? {
          type: "array",
          length: value.length,
          preview: value.slice(0, 20),
        }
      : value;
  }

  if (isRecord(value)) {
    const text = JSON.stringify(value);
    return text.length > 500
      ? {
          type: "object",
          keys: Object.keys(value).slice(0, 20),
        }
      : value;
  }

  return value;
}

function expectToolError(expected) {
  return ({ error, result }) => {
    const assertions = [
      assertThat("result is a structured tool error", isRecord(error) && result?.isError === true, {
        actual: {
          has_structured_error: isRecord(error),
          is_error: result?.isError === true,
        },
        expected: {
          has_structured_error: true,
          is_error: true,
        },
      }),
    ];

    if (expected.code !== undefined) {
      assertions.push(assertEqual("error code", error?.code, expected.code));
    }

    if (expected.status !== undefined) {
      assertions.push(assertEqual("error status", error?.status, expected.status));
    }

    if (expected.sourceRule !== undefined) {
      assertions.push(
        assertEqual("source_error.rule", error?.source_error?.rule, expected.sourceRule),
      );
    }

    if (expected.messageIncludes !== undefined) {
      assertions.push(
        assertThat(
          "error message includes expected text",
          String(error?.message).includes(expected.messageIncludes),
          {
            actual: String(error?.message),
            expected: expected.messageIncludes,
          },
        ),
      );
    }

    return assertAll(
      `got expected ${expected.code ?? expected.sourceRule ?? "tool"} error`,
      assertions,
    );
  };
}

function expectSdkValidationError(text) {
  return ({ result, structuredContent, thrown }) => {
    const message = textOf(result);
    return assertAll(`SDK validation error mentions ${text}`, [
      assertEqual("no exception thrown", thrown === undefined, true),
      assertEqual("result is MCP error", result?.isError, true),
      assertEqual("structured content omitted", structuredContent, undefined),
      assertThat(
        "message includes SDK validation prefix",
        message.includes("Input validation error"),
        {
          actual: message,
          expected: "Input validation error",
        },
      ),
      assertThat("message includes expected field text", message.includes(text), {
        actual: message,
        expected: text,
      }),
    ]);
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
    cassette: undefined,
    failFast: false,
    mode: "live",
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

    if (arg === "--record") {
      parsed.mode = "record";
      continue;
    }

    if (arg === "--replay") {
      parsed.mode = "replay";
      continue;
    }

    if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg.startsWith("--cassette=")) {
      parsed.cassette = resolve(process.cwd(), arg.slice("--cassette=".length));
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

  if (!VALID_MODES.has(parsed.mode)) {
    throw new Error(
      `Invalid --mode=${parsed.mode}. Expected one of: ${[...VALID_MODES].join(", ")}`,
    );
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/evaluate-mcp.mjs [--profile=canary|stress] [--mode=live|record|replay] [--cassette=path] [--report=path] [--quiet] [--fail-fast]

Profiles:
  canary  Fast live eval over MCP health, Socrata core path, and IDESCAT core path.
  stress  Full live eval over search, metadata, data, resources, caps, and regressions.

Modes:
  live    Call the MCP server directly and do not write a cassette.
  record  Call the MCP server directly and write a replay cassette after a green run.
  replay  Run against a previously recorded cassette without starting the MCP server.
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
