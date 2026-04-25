import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { createMcpServer, createPingMessage, serverName } from "../../src/mcp/server.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  socrataAppToken: undefined,
};

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
    vi.restoreAllMocks();
  });

  it("registers the Socrata tools", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_search_datasets");
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_describe_dataset");
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
});

async function connectInMemoryServer(config: AppConfig = testConfig) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config);
  const client = new Client({
    name: "catalunya-opendata-mcp-vitest",
    version: "0.1.0",
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
