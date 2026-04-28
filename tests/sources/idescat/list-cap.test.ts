import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import { listIdescatNodes } from "../../../src/sources/idescat/catalog.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 2_500,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  bcnGeoScanMaxRows: 10_000,
  bcnGeoScanBytes: 67_108_864,
  socrataAppToken: undefined,
};

describe("IDESCAT list byte caps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("truncates high-cardinality list results to fit the response cap", async () => {
    mockJson({
      class: "collection",
      label: "Large node collection",
      href: "https://api.idescat.cat/taules/v2/pmh",
      link: {
        item: Array.from({ length: 50 }, (_, index) => ({
          href: String(1000 + index),
          label: `Very long node label ${index} ${"x".repeat(80)}`,
        })),
      },
    });

    const result = await listIdescatNodes(
      {
        statistics_id: "pmh",
        limit: 50,
      },
      baseConfig,
    );

    expect(result.data.total).toBe(50);
    expect(result.data.truncated).toBe(true);
    expect(result.data.truncation_reason).toBe("byte_cap");
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(result.data.items.length).toBeLessThan(50);
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
