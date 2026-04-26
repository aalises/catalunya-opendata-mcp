import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import { listIdescatNodes, listIdescatTables } from "../../../src/sources/idescat/catalog.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  socrataAppToken: undefined,
};

describe("listIdescatNodes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves relative item hrefs against the collection's own href", async () => {
    // Pre-fix bug: relative hrefs resolved against IDESCAT_TABLES_BASE_URL
    // (no trailing slash) lost the `v2` segment and were rejected as
    // "outside Tables v2". Verify they now resolve correctly.
    mockJson({
      class: "collection",
      label: "Padró municipal",
      href: "https://api.idescat.cat/taules/v2/pmh",
      link: {
        item: [
          { href: "1180", label: "1180" },
          { href: "1190", label: "1190" },
        ],
      },
    });

    const result = await listIdescatNodes({ statistics_id: "pmh" }, baseConfig);

    expect(result.data.items).toEqual([
      { statistics_id: "pmh", node_id: "1180", label: "1180", href: "1180" },
      { statistics_id: "pmh", node_id: "1190", label: "1190", href: "1190" },
    ]);
  });

  it("still accepts absolute item hrefs", async () => {
    mockJson({
      class: "collection",
      label: "Padró municipal",
      href: "https://api.idescat.cat/taules/v2/pmh",
      link: {
        item: [
          {
            href: "https://api.idescat.cat/taules/v2/pmh/1180",
            label: "1180",
          },
        ],
      },
    });

    const result = await listIdescatNodes({ statistics_id: "pmh" }, baseConfig);

    expect(result.data.items[0]?.node_id).toBe("1180");
  });
});

describe("listIdescatTables", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves upstream `updated` field on table items when present", async () => {
    mockJson({
      class: "collection",
      label: "Tables under 1180",
      href: "https://api.idescat.cat/taules/v2/pmh/1180",
      link: {
        item: [
          {
            href: "8078",
            label: "8078",
            updated: "2026-01-15",
          },
        ],
      },
    });

    const result = await listIdescatTables({ statistics_id: "pmh", node_id: "1180" }, baseConfig);

    expect(result.data.items[0]).toMatchObject({
      table_id: "8078",
      updated: "2026-01-15",
    });
  });
});

function mockJson(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
}
