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

  it("registers the Socrata search tool", async () => {
    const { client, close } = await connectInMemoryServer();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("socrata_search_datasets");
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
