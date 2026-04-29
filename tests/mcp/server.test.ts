import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { createMcpServer, createPingMessage, serverName } from "../../src/mcp/server.js";
import { packageVersion } from "../../src/package-info.js";
import { BCN_PLACE_REGISTRY } from "../../src/sources/bcn/place.js";
import { IDESCAT_LOGICAL_URL_MAX_BYTES } from "../../src/sources/idescat/request.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  bcnGeoScanMaxRows: 10_000,
  bcnGeoScanBytes: 67_108_864,
  socrataAppToken: undefined,
};
const ORIGINAL_BCN_PLACE_REGISTRY = [...BCN_PLACE_REGISTRY];

describe("createPingMessage", () => {
  it("returns the default health message", () => {
    expect(createPingMessage()).toBe(`Hola. ${serverName} is running.`);
  });

  it("includes the provided name", () => {
    expect(createPingMessage("Albert")).toBe(`Hola, Albert. ${serverName} is running.`);
  });
});

describe("createMcpServer", () => {
  afterEach(() => {
    BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...ORIGINAL_BCN_PLACE_REGISTRY);
    vi.restoreAllMocks();
  });

  it("registers the Socrata tools", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_search_datasets");
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_describe_dataset");
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_query_dataset");

      const queryTool = tools.tools.find((tool) => tool.name === "socrata_query_dataset");
      expect(queryTool?.description).toContain("socrata_describe_dataset");
      expect(queryTool?.description).toContain("field_name");
      expect(queryTool?.description).toContain("?$where=");
      expect(queryTool?.description).toContain("offset");
      expect(queryTool?.description).toContain("narrowing filters");
      expect(queryTool?.description).toContain("Aggregate queries");
    } finally {
      await close();
    }
  });

  it("registers the IDESCAT tools, prompts, and metadata resource template", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "idescat_search_tables",
          "idescat_list_statistics",
          "idescat_list_nodes",
          "idescat_list_tables",
          "idescat_list_table_geos",
          "idescat_get_table_metadata",
          "idescat_get_table_data",
        ]),
      );

      const descriptions = Object.fromEntries(
        tools.tools
          .filter((tool) => tool.name.startsWith("idescat_"))
          .map((tool) => [tool.name, tool.description ?? ""]),
      );
      expect(descriptions.idescat_search_tables).toContain("Topic discovery");
      expect(descriptions.idescat_search_tables).toContain("named places");
      expect(descriptions.idescat_search_tables).toContain("semantic aliases");
      expect(descriptions.idescat_search_tables).toContain("taxa atur");
      expect(descriptions.idescat_search_tables).toContain("idescat_list_table_geos");
      expect(descriptions.idescat_search_tables).toContain("geo_candidates");
      expect(descriptions.idescat_list_statistics).toContain("Browse fallback");
      expect(descriptions.idescat_list_statistics).toContain("idescat_list_nodes");
      expect(descriptions.idescat_list_nodes).toContain("idescat_list_statistics");
      expect(descriptions.idescat_list_nodes).toContain("idescat_list_tables");
      expect(descriptions.idescat_list_tables).toContain("idescat_list_table_geos");
      expect(descriptions.idescat_list_table_geos).toContain("Required bridge");
      expect(descriptions.idescat_list_table_geos).toContain("idescat_get_table_metadata");
      expect(descriptions.idescat_get_table_metadata).toContain("dimension IDs");
      expect(descriptions.idescat_get_table_metadata).toContain("place_query");
      expect(descriptions.idescat_get_table_metadata).toContain("filter_guidance");
      expect(descriptions.idescat_get_table_metadata).toContain("idescat_get_table_data");
      expect(descriptions.idescat_get_table_data).toContain("bounded");
      expect(descriptions.idescat_get_table_data).toContain("idescat_get_table_metadata");
      expect(descriptions.idescat_get_table_data).toContain("last");

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(["idescat_query_workflow", "idescat_citation"]),
      );

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toContainEqual(
        expect.objectContaining({
          name: "idescat_table_metadata",
          uriTemplate: "idescat://tables/{statistics_id}/{node_id}/{table_id}/{geo_id}/metadata",
          mimeType: "application/json",
        }),
      );
    } finally {
      await close();
    }
  });

  it("registers the BCN tools, prompts, and resource templates", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "bcn_search_packages",
          "bcn_get_package",
          "bcn_get_resource_info",
          "bcn_query_resource",
          "bcn_resolve_place",
          "bcn_recommend_resources",
          "bcn_query_resource_geo",
          "bcn_preview_resource",
        ]),
      );

      const descriptions = Object.fromEntries(
        tools.tools
          .filter((tool) => tool.name.startsWith("bcn_"))
          .map((tool) => [tool.name, tool.description ?? ""]),
      );
      expect(descriptions.bcn_search_packages).toContain("Open Data BCN");
      expect(descriptions.bcn_query_resource).toContain("bcn_get_resource_info");
      expect(descriptions.bcn_query_resource).toContain("filters as a JSON object");
      expect(descriptions.bcn_resolve_place).toContain("named place");
      expect(descriptions.bcn_recommend_resources).toContain("Recommend");
      expect(descriptions.bcn_query_resource_geo).toContain("geospatial query");
      expect(descriptions.bcn_query_resource_geo).toContain("group_by");
      expect(descriptions.bcn_query_resource_geo).toContain("within_place");
      expect(descriptions.bcn_preview_resource).toContain("HTTPS BCN-hosted");

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(["bcn_query_workflow", "bcn_citation"]),
      );

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "bcn_package",
            uriTemplate: "bcn://packages/{package_id}",
            mimeType: "application/json",
          }),
          expect.objectContaining({
            name: "bcn_resource_schema",
            uriTemplate: "bcn://resources/{resource_id}/schema",
            mimeType: "application/json",
          }),
        ]),
      );
    } finally {
      await close();
    }
  });

  it("returns structured BCN search output with JSON text fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      bcnCkanSuccess({ count: 1, results: [bcnPackage()] }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = (await client.callTool({
        name: "bcn_search_packages",
        arguments: {
          query: "arbrat",
          limit: 1,
        },
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: {
          query: "arbrat",
          results: [
            {
              package_id: "package-1",
              title: "Package title",
            },
          ],
        },
        provenance: {
          source: "bcn",
          id: "opendata-ajuntament.barcelona.cat:package_search",
        },
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(result.structuredContent);
    } finally {
      await close();
    }
  });

  it("returns structured BCN place resolver output with JSON text fallback", async () => {
    const facilityPlaceResource = ORIGINAL_BCN_PLACE_REGISTRY.find(
      (resource) => resource.resourceId === "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    );

    if (!facilityPlaceResource) {
      throw new Error("Expected BCN facility place registry resource to exist.");
    }

    BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, facilityPlaceResource);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bcnCkanSuccess({
        fields: [
          { id: "name", type: "text" },
          { id: "addresses_road_name", type: "text" },
          { id: "addresses_neighborhood_name", type: "text" },
          { id: "addresses_district_name", type: "text" },
          { id: "secondary_filters_name", type: "text" },
          { id: "geo_epgs_4326_lat", type: "numeric" },
          { id: "geo_epgs_4326_lon", type: "numeric" },
        ],
        records: [
          {
            name: "Park Güell. Museu d'Història de Barcelona",
            addresses_road_name: "C Olot",
            addresses_neighborhood_name: "la Salut",
            addresses_district_name: "Gràcia",
            secondary_filters_name: "Museus",
            geo_epgs_4326_lat: "41.41350925781701",
            geo_epgs_4326_lon: "2.153127208234728",
          },
        ],
        total: 1,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = (await client.callTool({
        name: "bcn_resolve_place",
        arguments: {
          query: "Park",
          kinds: ["landmark"],
          limit: 1,
        },
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: {
          query: "Park",
          strategy: "datastore",
          candidate_count: 1,
          candidates: [
            {
              name: "Park Güell. Museu d'Història de Barcelona",
              kind: "landmark",
              lat: 41.41350925781701,
              lon: 2.153127208234728,
            },
          ],
        },
        provenance: {
          source: "bcn",
          id: "opendata-ajuntament.barcelona.cat:place_resolve",
        },
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(result.structuredContent);
    } finally {
      await close();
    }
  });

  it("returns structured BCN resource recommendations with JSON text fallback", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = (await client.callTool({
        name: "bcn_recommend_resources",
        arguments: {
          query: "tree species on Carrer Consell de Cent",
          task: "group",
          place_kind: "street",
          limit: 1,
        },
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: {
          query: "tree species on Carrer Consell de Cent",
          task: "group",
          place_kind: "street",
          recommendation_count: 1,
          recommendations: [
            {
              title: "Street trees (Arbrat viari)",
              resource_id: "23124fd5-521f-40f8-85b8-efb1e71c2ec8",
              suggested_tool: "bcn_query_resource_geo",
              example_arguments: {
                contains: {
                  adreca: "<street name>",
                },
                group_by: "cat_nom_catala",
              },
            },
          ],
        },
        provenance: {
          source: "bcn",
          id: "opendata-ajuntament.barcelona.cat:resource_recommend",
        },
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(result.structuredContent);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("returns structured BCN geo output with JSON text fallback", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        bcnCkanSuccess(
          bcnResource({
            datastore_active: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        bcnCkanSuccess({
          fields: [
            { id: "_id", type: "int" },
            { id: "name", type: "text" },
            { id: "latitud", type: "numeric" },
            { id: "longitud", type: "numeric" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        bcnCkanSuccess({
          records: [
            {
              _bcn_matched_total: 1,
              _id: 1,
              name: "Point A",
              latitud: 41.4036,
              longitud: 2.1744,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(bcnCkanSuccess({ records: [] }));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = (await client.callTool({
        name: "bcn_query_resource_geo",
        arguments: {
          resource_id: "resource-1",
          near: { lat: 41.4036, lon: 2.1744, radius_m: 100 },
          fields: ["_id", "name"],
          limit: 1,
        },
      })) as ToolCallResult;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: {
          resource_id: "resource-1",
          strategy: "datastore",
          datastore_mode: "sql",
          coordinate_fields: {
            lat: "latitud",
            lon: "longitud",
          },
          rows: [
            {
              _id: 1,
              name: "Point A",
              _geo: {
                lat: 41.4036,
                lon: 2.1744,
              },
            },
          ],
        },
        provenance: {
          source: "bcn",
          id: "opendata-ajuntament.barcelona.cat:resource_geo_query",
        },
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(result.structuredContent);
    } finally {
      await close();
    }
  });

  it("returns BCN error envelopes with source_error through the MCP tool surface", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bcnCkanFailure({ message: "Not found in datastore" }))
      .mockResolvedValueOnce(
        bcnCkanSuccess(
          bcnResource({
            datastore_active: false,
            package_id: null,
          }),
        ),
      );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = (await client.callTool({
        name: "bcn_query_resource",
        arguments: {
          resource_id: "resource-1",
          limit: 2,
        },
      })) as ToolCallResult;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        data: null,
        error: {
          source: "bcn",
          code: "invalid_input",
          message: expect.stringContaining("not DataStore-active"),
          retryable: false,
          source_error: {
            message: "Not found in datastore",
          },
        },
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(result.structuredContent);
    } finally {
      await close();
    }
  });

  it("reads BCN package and resource schema templates as JSON artifacts", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bcnCkanSuccess(bcnPackage()))
      .mockResolvedValueOnce(
        bcnCkanSuccess(
          bcnResource({
            datastore_active: true,
            package_id: null,
          }),
        ),
      )
      .mockResolvedValueOnce(
        bcnCkanSuccess({
          fields: [{ id: "Nom", type: "text" }],
        }),
      );
    const { client, close } = await connectInMemoryServer();

    try {
      const packageResult = await client.readResource({
        uri: "bcn://packages/package-1",
      });
      const packageContent = packageResult.contents[0];
      const packageData = JSON.parse("text" in packageContent ? packageContent.text : "{}");

      expect(packageData).toMatchObject({
        package_id: "package-1",
        resources: [
          {
            resource_id: "resource-1",
          },
        ],
      });
      expect(packageData.data).toBeUndefined();
      expect(packageData.error).toBeUndefined();

      const schemaResult = await client.readResource({
        uri: "bcn://resources/resource-1/schema",
      });
      const schemaContent = schemaResult.contents[0];
      const schemaData = JSON.parse("text" in schemaContent ? schemaContent.text : "{}");

      expect(schemaData).toMatchObject({
        resource_id: "resource-1",
        fields: [{ id: "Nom", type: "text" }],
      });
    } finally {
      await close();
    }
  });

  it("registers the IDESCAT query workflow prompt as an ordered playbook", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const prompt = await client.getPrompt({
        name: "idescat_query_workflow",
      });
      const text = prompt.messages
        .map((message) => message.content)
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");

      const searchIndex = text.indexOf("idescat_search_tables");
      const browseIndex = text.indexOf("idescat_list_statistics");
      const geosIndex = text.indexOf("idescat_list_table_geos");
      const metadataIndex = text.indexOf("idescat_get_table_metadata");
      const dataIndex = text.indexOf("idescat_get_table_data");
      const citationIndex = text.indexOf("Cite `idescat_get_table_metadata`");

      expect(searchIndex).toBeGreaterThanOrEqual(0);
      expect(browseIndex).toBeGreaterThan(searchIndex);
      expect(geosIndex).toBeGreaterThan(browseIndex);
      expect(metadataIndex).toBeGreaterThan(geosIndex);
      expect(dataIndex).toBeGreaterThan(metadataIndex);
      expect(citationIndex).toBeGreaterThan(dataIndex);
      expect(text).toContain("Use returned dimension IDs and category IDs exactly");
      expect(text).toContain("semantic aliases");
      expect(text).toContain("renda per capita");
      expect(text).toContain("place_query");
      expect(text).toContain("filter_guidance.recommended_data_call");
      expect(text).toContain("Treat search/list provenance as discovery-only");
      expect(text).toContain("geo_candidates");
      expect(text).toContain("do not invent a geo_id");
      expect(text).toContain("`narrow_filters`: call metadata");
      expect(text).toContain("Filter cap errors: reduce or split filters");
    } finally {
      await close();
    }
  });

  it("searches the committed IDESCAT table index without calling upstream", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_search_tables",
        arguments: {
          query: "poblacio 1 gener sexe edat 2014",
          limit: 1,
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBeUndefined();
      expect(toolResult.structuredContent).toMatchObject({
        data: {
          query: "poblacio 1 gener sexe edat 2014",
          lang: "ca",
          requested_lang: "ca",
          limit: 1,
          results: [
            {
              statistics_id: "pmh",
              node_id: "1180",
              table_id: "8078",
              geo_candidates: expect.any(Array),
            },
          ],
        },
        provenance: {
          source: "idescat",
          id: "idescat:tables:table_search",
        },
      });
      const first = toolResult.structuredContent?.data as
        | { results?: Array<Record<string, unknown>> }
        | undefined;
      expect(first?.results?.[0]).not.toHaveProperty("geo_ids");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("returns IDESCAT metadata filter guidance for named-place queries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(idescatGuidanceMetadata()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_metadata",
        arguments: {
          statistics_id: "rfdbc",
          node_id: "13302",
          table_id: "21197",
          geo_id: "com",
          place_query: "renda Maresme",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBeUndefined();
      expect(toolResult.structuredContent).toMatchObject({
        data: {
          filter_guidance: {
            place_matches: [
              {
                dimension_id: "COM",
                category_id: "21",
                category_label: "Maresme",
              },
            ],
            recommended_filters: {
              COM: "21",
              CONCEPT: "GROSS_INCOME",
              MAIN_RESOURCES_USES_INCOME: "TOTAL",
            },
            latest: {
              last: 1,
              time_dimension_ids: ["YEAR"],
            },
            recommended_data_call: {
              filters: {
                COM: "21",
                CONCEPT: "GROSS_INCOME",
                MAIN_RESOURCES_USES_INCOME: "TOTAL",
              },
              last: 1,
              limit: 20,
            },
          },
        },
      });
    } finally {
      await close();
    }
  });

  it("returns structured IDESCAT input errors from the adapter", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_data",
        arguments: {
          statistics_id: " pmh ",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        provenance: {
          source: "idescat",
          source_url: "https://api.idescat.cat/taules/v2?lang=ca",
        },
        error: {
          source: "idescat",
          code: "invalid_input",
          message: expect.stringContaining("IDs returned by IDESCAT search/list"),
          retryable: false,
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("adds IDESCAT narrow_filters recovery guidance while preserving the error shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "2.0",
          class: "error",
          status: "416",
          id: "05",
          label: "Data limit exceeded.",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 416,
        },
      ),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_data",
        arguments: {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        error: {
          source: "idescat",
          code: "narrow_filters",
          message: expect.stringContaining("idescat_get_table_metadata"),
          retryable: false,
          status: 416,
          source_error: {
            id: "05",
            status: "416",
          },
        },
      });
      const error = toolResult.structuredContent?.error as { message?: string } | undefined;
      expect(error?.message).toContain("dimension filters or last");
    } finally {
      await close();
    }
  });

  it("adds IDESCAT filter-cap recovery guidance while preserving source_error.rule", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_data",
        arguments: {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
          filters: {
            COM: "x".repeat(257),
          },
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        error: {
          source: "idescat",
          code: "invalid_input",
          message: expect.stringContaining("reduce or split filters"),
          retryable: false,
          source_error: {
            rule: "filter_value_bytes",
            limit: 256,
          },
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("rejects overlong IDESCAT data GET URLs before calling upstream", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_data",
        arguments: {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "com",
          filters: {
            COM: Array(15).fill("é".repeat(128)),
          },
          limit: 1,
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        error: {
          source: "idescat",
          code: "invalid_input",
          message: expect.stringContaining("reduce or split filters"),
          retryable: false,
          source_error: {
            rule: "logical_url_bytes",
            limit: IDESCAT_LOGICAL_URL_MAX_BYTES,
          },
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("registers the Socrata query workflow prompt", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("socrata_query_workflow");

      const prompt = await client.getPrompt({
        name: "socrata_query_workflow",
      });
      const textMessages = prompt.messages
        .map((message) => message.content)
        .filter((content) => content.type === "text");

      expect(textMessages.length).toBeGreaterThan(0);
      expect(textMessages.some((content) => content.text.trim().length > 0)).toBe(true);
    } finally {
      await close();
    }
  });

  it("registers the Socrata citation prompt", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("socrata_citation");

      const prompt = await client.getPrompt({
        name: "socrata_citation",
      });
      const textMessages = prompt.messages
        .map((message) => message.content)
        .filter((content) => content.type === "text");

      expect(textMessages.length).toBeGreaterThan(0);
      expect(textMessages.some((content) => content.text.trim().length > 0)).toBe(true);
    } finally {
      await close();
    }
  });

  it("registers the Socrata metadata resource template", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates).toContainEqual(
        expect.objectContaining({
          name: "socrata_dataset_metadata",
          uriTemplate: "socrata://datasets/{source_id}/metadata",
          mimeType: "application/json",
        }),
      );
    } finally {
      await close();
    }
  });

  it("reads Socrata metadata resources as dataset metadata JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(viewMetadata()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.readResource({
        uri: "socrata://datasets/v8i4-fa4q/metadata",
      });
      const content = result.contents[0];

      expect(content).toMatchObject({
        uri: "socrata://datasets/v8i4-fa4q/metadata",
        mimeType: "application/json",
      });
      expect("text" in content).toBe(true);

      const metadata = JSON.parse("text" in content ? content.text : "{}");

      expect(metadata).toMatchObject({
        source_id: "v8i4-fa4q",
        columns: [
          {
            field_name: "municipi",
          },
        ],
        provenance: {
          source: "socrata",
          id: "v8i4-fa4q",
        },
      });
      expect(metadata.data).toBeUndefined();
      expect(metadata.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("rejects malformed Socrata metadata resource source IDs without fetching", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      await expect(
        client.readResource({
          uri: "socrata://datasets/not-a-real-id/metadata",
        }),
      ).rejects.toThrow("source_id");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("surfaces Socrata metadata resource upstream errors as JSON-RPC errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        headers: { "Content-Type": "application/json" },
        status: 404,
        statusText: "Not Found",
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      await expect(
        client.readResource({
          uri: "socrata://datasets/v8i4-fa4q/metadata",
        }),
      ).rejects.toThrow("HTTP 404");
    } finally {
      await close();
    }
  });

  it("returns structured Socrata search output and compact JSON text fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          resultSetSize: 1,
          results: [
            {
              resource: {
                id: "v8i4-fa4q",
                name: "Habitatge public",
                description: "Dataset about housing.",
                updatedAt: "2026-03-18T10:27:52.000Z",
              },
              metadata: {
                domain: "analisi.transparenciacatalunya.cat",
                license: "See Terms of Use",
              },
              permalink: "https://analisi.transparenciacatalunya.cat/d/v8i4-fa4q",
            },
          ],
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "socrata_search_datasets",
        arguments: {
          query: "habitatge",
          limit: 1,
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBeUndefined();
      expect(toolResult.structuredContent).toMatchObject({
        data: {
          query: "habitatge",
          limit: 1,
          offset: 0,
          total: 1,
          results: [
            {
              title: "Habitatge public",
              source_id: "v8i4-fa4q",
              updated_at: "2026-03-18T10:27:52.000Z",
            },
          ],
        },
        provenance: {
          source: "socrata",
          id: "analisi.transparenciacatalunya.cat:catalog_search",
        },
      });
      expect(toolResult.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify(toolResult.structuredContent),
      });
    } finally {
      await close();
    }
  });

  it("rejects Socrata search limits above the configured maximum with a tool error", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer({
      ...testConfig,
      maxResults: 2,
    });

    try {
      const result = await client.callTool({
        name: "socrata_search_datasets",
        arguments: {
          query: "habitatge",
          limit: 3,
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("returns structured Socrata describe output and compact JSON text fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(viewMetadata()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "socrata_describe_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBeUndefined();
      expect(toolResult.structuredContent).toMatchObject({
        data: {
          title: "Habitatges amb protecció oficial",
          source_id: "v8i4-fa4q",
          license_or_terms: "See Terms of Use",
          columns: [
            {
              display_name: "Municipi",
              field_name: "municipi",
              datatype: "text",
            },
          ],
          provenance: {
            source: "socrata",
            id: "v8i4-fa4q",
          },
        },
        provenance: {
          source: "socrata",
          id: "analisi.transparenciacatalunya.cat:dataset_describe",
        },
      });
      expect(toolResult.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify(toolResult.structuredContent),
      });
    } finally {
      await close();
    }
  });

  it("rejects malformed Socrata source IDs with a tool error", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer();

    try {
      for (const sourceId of ["abc", "v8i4_fa4q", "V8I4-FA4Q", "../v8i4-fa4q"]) {
        const result = await client.callTool({
          name: "socrata_describe_dataset",
          arguments: {
            source_id: sourceId,
          },
        });
        const toolResult = result as ToolCallResult;

        expect(toolResult.isError).toBe(true);
        expect(toolResult.structuredContent).toMatchObject({
          data: null,
          error: {
            source: "socrata",
            code: "invalid_input",
            retryable: false,
          },
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("returns structured Socrata describe errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        headers: { "Content-Type": "application/json" },
        status: 404,
        statusText: "Not Found",
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "socrata_describe_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        provenance: {
          source: "socrata",
          id: "analisi.transparenciacatalunya.cat:dataset_describe",
        },
        error: {
          source: "socrata",
          code: "http_error",
          retryable: false,
          status: 404,
        },
      });
    } finally {
      await close();
    }
  });

  it("returns structured Socrata query output and compact JSON text fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ municipi: "Girona" }, { municipi: "Salt" }]), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "socrata_query_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
          select: "municipi",
          where: "comarca = 'Gironès'",
          order: "municipi",
          limit: 1,
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBeUndefined();
      expect(toolResult.structuredContent).toMatchObject({
        data: {
          source_id: "v8i4-fa4q",
          select: "municipi",
          where: "comarca = 'Gironès'",
          order: "municipi",
          limit: 1,
          offset: 0,
          row_count: 1,
          truncated: true,
          truncation_reason: "row_cap",
          rows: [{ municipi: "Girona" }],
        },
        provenance: {
          source: "socrata",
          id: "analisi.transparenciacatalunya.cat:dataset_query",
        },
      });
      const data = (toolResult.structuredContent?.data ?? {}) as Record<string, unknown>;
      expect(new URL(data.request_url as string).searchParams.get("$limit")).toBe("2");
      expect(new URL(data.logical_request_url as string).searchParams.get("$limit")).toBe("1");
      expect(toolResult.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify(toolResult.structuredContent),
      });
    } finally {
      await close();
    }
  });

  it("returns structured Socrata query input errors from the adapter", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const { client, close } = await connectInMemoryServer({
      ...testConfig,
      maxResults: 2,
    });

    try {
      for (const args of [
        { source_id: "abc" },
        { source_id: "v8i4-fa4q", limit: 3 },
        { source_id: "v8i4-fa4q", limit: 1.5 },
        { source_id: "v8i4-fa4q", limit: 0 },
        { source_id: "v8i4-fa4q", limit: 1e21 },
        { source_id: "v8i4-fa4q", offset: -1 },
        { source_id: "v8i4-fa4q", offset: 1e21 },
      ]) {
        const result = await client.callTool({
          name: "socrata_query_dataset",
          arguments: args,
        });
        const toolResult = result as ToolCallResult;

        expect(toolResult.isError).toBe(true);
        expect(toolResult.structuredContent).toMatchObject({
          data: null,
          error: {
            source: "socrata",
            code: "invalid_input",
            retryable: false,
          },
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("returns Socrata query HTTP error bodies so callers can self-correct", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "No such column: municipi_nom" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
        statusText: "Bad Request",
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "socrata_query_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
          select: "municipi_nom",
        },
      });
      const toolResult = result as ToolCallResult;

      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent).toMatchObject({
        data: null,
        error: {
          source: "socrata",
          code: "http_error",
          message: expect.stringContaining(
            'Response body: {"message":"No such column: municipi_nom"}',
          ),
          retryable: false,
          source_error: {
            message: "No such column: municipi_nom",
          },
          status: 400,
        },
      });
    } finally {
      await close();
    }
  });

  it("supports the full mocked Socrata search to describe to query workflow", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resultSetSize: 1,
            results: [
              {
                resource: {
                  id: "v8i4-fa4q",
                  name: "Habitatge public",
                  description: "Dataset about housing.",
                  updatedAt: "2026-03-18T10:27:52.000Z",
                },
                metadata: {
                  domain: "analisi.transparenciacatalunya.cat",
                  license: "See Terms of Use",
                },
                permalink: "https://analisi.transparenciacatalunya.cat/d/v8i4-fa4q",
              },
            ],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(viewMetadata()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ comarca: "Gironès", total: "2" }]), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    const { client, close } = await connectInMemoryServer();

    try {
      const search = (await client.callTool({
        name: "socrata_search_datasets",
        arguments: {
          query: "habitatge",
          limit: 1,
        },
      })) as ToolCallResult;
      expect(search.isError).toBeUndefined();

      const describe = (await client.callTool({
        name: "socrata_describe_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
        },
      })) as ToolCallResult;
      expect(describe.isError).toBeUndefined();

      const query = (await client.callTool({
        name: "socrata_query_dataset",
        arguments: {
          source_id: "v8i4-fa4q",
          select: "comarca, count(*) as total",
          group: "comarca",
          limit: 10,
        },
      })) as ToolCallResult;
      expect(query.isError).toBeUndefined();
      expect(query.structuredContent).toMatchObject({
        data: {
          group: "comarca",
          rows: [{ comarca: "Gironès", total: "2" }],
        },
      });
    } finally {
      await close();
    }
  });
});

async function connectInMemoryServer(config: AppConfig = testConfig) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({
    name: "catalunya-opendata-mcp-vitest",
    version: packageVersion,
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

interface ToolCallResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function bcnCkanSuccess(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function bcnCkanFailure(error: unknown): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function bcnPackage() {
  return {
    id: "package-1",
    name: "package-name",
    title: "Package title",
    notes: "Package description",
    license_title: "CC BY 4.0",
    metadata_modified: "2024-01-02T00:00:00",
    resources: [bcnResource({ package_id: "package-1" })],
    tags: [{ display_name: "Trees" }],
  };
}

function bcnResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    name: "Resource 1",
    description: "Resource description",
    datastore_active: false,
    format: "CSV",
    last_modified: "2024-01-01T00:00:00",
    mimetype: "text/csv",
    package_id: null,
    url: "https://opendata-ajuntament.barcelona.cat/download/resource-1.csv",
    ...overrides,
  };
}

function viewMetadata() {
  return {
    id: "v8i4-fa4q",
    name: "Habitatges amb protecció oficial",
    attribution: "Departament de Territori",
    attributionLink: "https://example.test/terms",
    category: "Habitatge",
    createdAt: 1_700_000_000,
    description: "Dataset about housing.",
    license: { name: "See Terms of Use" },
    licenseId: "SEE_TERMS_OF_USE",
    publicationDate: 1_700_000_100,
    rowsUpdatedAt: 1_700_000_300,
    viewLastModified: 1_700_000_200,
    columns: [
      {
        name: "Municipi",
        dataTypeName: "text",
        description: "Nom del municipi",
        fieldName: "municipi",
      },
    ],
  };
}

function idescatGuidanceMetadata() {
  return {
    version: "2.0",
    class: "dataset",
    label: "Components de la RFDB",
    id: ["YEAR", "COM", "CONCEPT", "INDICATOR", "MAIN_RESOURCES_USES_INCOME"],
    size: [2, 2, 1, 2, 2],
    role: {
      time: ["YEAR"],
      geo: ["COM"],
      metric: ["CONCEPT", "INDICATOR"],
    },
    dimension: {
      YEAR: {
        label: "any",
        category: {
          index: ["2022", "2023"],
          label: {
            "2022": "2022",
            "2023": "2023",
          },
        },
      },
      COM: {
        label: "comarca o Aran",
        category: {
          index: ["13", "21"],
          label: {
            "13": "Barcelonès",
            "21": "Maresme",
          },
        },
      },
      CONCEPT: {
        label: "concepte",
        category: {
          index: ["GROSS_INCOME"],
          label: {
            GROSS_INCOME: "renda familiar disponible bruta",
          },
        },
      },
      INDICATOR: {
        label: "indicador",
        category: {
          index: ["VALUE_EK", "REL_WEIGHT_SG"],
          label: {
            VALUE_EK: "valor (milers €)",
            REL_WEIGHT_SG: "pes (%)",
          },
        },
      },
      MAIN_RESOURCES_USES_INCOME: {
        label: "components de la renda",
        category: {
          index: ["COMP_EMPL", "TOTAL"],
          label: {
            COMP_EMPL: "remuneració d'assalariats (+)",
            TOTAL: "total",
          },
        },
      },
    },
  };
}
