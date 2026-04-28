import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { packageVersion } from "../../src/package-info.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 10,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 8_000,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  socrataAppToken: undefined,
};

describe("IDESCAT metadata degradation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops large geo categories and keeps a geo-aware degradation hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(largeGeoMetadata()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const { client, close } = await connectInMemoryServer();

    try {
      const result = await client.callTool({
        name: "idescat_get_table_metadata",
        arguments: {
          statistics_id: "pmh",
          node_id: "1180",
          table_id: "8078",
          geo_id: "mun",
        },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        data: {
          degradation: {
            dropped: ["categories_for_dimensions"],
            dimension_ids: ["GEO"],
          },
        },
      });

      const data = (result as ToolCallResult).structuredContent?.data as {
        degradation?: { hint?: string };
        dimensions?: Array<{ categories: unknown[]; categories_omitted?: boolean; id: string }>;
      };
      const geo = data.dimensions?.find((dimension) => dimension.id === "GEO");

      expect(geo).toMatchObject({
        categories: [],
        categories_omitted: true,
      });
      expect(data.degradation?.hint).toContain("idescat_list_table_geos");
    } finally {
      await close();
    }
  });
});

async function connectInMemoryServer(config: AppConfig = baseConfig) {
  const server = createMcpServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({
    name: "catalunya-opendata-mcp-vitest",
    version: packageVersion,
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

interface ToolCallResult {
  structuredContent?: {
    data?: unknown;
  };
}

function largeGeoMetadata() {
  const labels = Object.fromEntries(
    Array.from({ length: 260 }, (_, index) => [
      `M${String(index).padStart(3, "0")}`,
      `Municipality ${index} with a long enough label for response sizing`,
    ]),
  );
  const ids = Object.keys(labels);

  return {
    version: "2.0",
    class: "dataset",
    label: "Large municipality metadata",
    id: ["GEO", "CONCEPT"],
    size: [ids.length, 1],
    role: {
      geo: ["GEO"],
      metric: ["CONCEPT"],
    },
    dimension: {
      GEO: {
        label: "municipality",
        category: {
          index: ids,
          label: labels,
        },
      },
      CONCEPT: {
        label: "concept",
        category: {
          index: ["POP"],
          label: {
            POP: "population",
          },
        },
      },
    },
    link: {
      related: {
        href: "https://api.idescat.cat/taules/v2/pmh/1180/8078/com",
        label: "County geography",
      },
    },
    note: ["Metadata note"],
    extension: {
      source: ["Idescat"],
    },
  };
}
