import { describe, expect, it } from "vitest";

import { getUrlByteLength, getUtf8ByteLength } from "../../../src/sources/common/caps.js";
import { IdescatError } from "../../../src/sources/idescat/client.js";
import {
  buildIdescatDataRequest,
  IDESCAT_FILTER_COUNT_MAX,
  IDESCAT_FILTER_KEY_MAX_BYTES,
  IDESCAT_FILTER_TOTAL_MAX_BYTES,
  IDESCAT_FILTER_VALUE_MAX_BYTES,
  IDESCAT_LOGICAL_URL_MAX_BYTES,
} from "../../../src/sources/idescat/request.js";

const baseInput = {
  statistics_id: "pmh",
  node_id: "1180",
  table_id: "8078",
  geo_id: "com",
  lang: "en" as const,
};
const FORMER_POST_THRESHOLD_BYTES = 2_000;

describe("buildIdescatDataRequest", () => {
  it("keeps an exactly 2000-byte canonical URL as GET", () => {
    // Filter sizing is hand-tuned to the current IDESCAT_TABLES_BASE_URL and the
    // pmh/1180/8078/com path. If the base URL ever moves, recalculate the K
    // value lengths so the canonical URL still lands at exactly 2000 bytes.
    const request = buildIdescatDataRequest({
      ...baseInput,
      lang: "ca",
      filters: {
        K: Array(8).fill("x".repeat(239)),
      },
    });

    expect(getUrlByteLength(request.logicalRequestUrl)).toBe(FORMER_POST_THRESHOLD_BYTES);
    expect(request.requestMethod).toBe("GET");
    expect(request.request.url.toString()).toBe(request.logicalRequestUrl.toString());
    expect(request).not.toHaveProperty("requestBodyParams");
  });

  it("keeps filters in a GET URL above the former 2000-byte POST threshold", () => {
    const request = buildIdescatDataRequest({
      ...baseInput,
      filters: {
        B: "2",
        A: ["1", "3"],
        AA: "4",
        K: Array(8).fill("x".repeat(240)),
      },
      last: 2,
    });

    expect(getUrlByteLength(request.logicalRequestUrl)).toBeGreaterThan(
      FORMER_POST_THRESHOLD_BYTES,
    );
    expect(getUrlByteLength(request.logicalRequestUrl)).toBeLessThanOrEqual(
      IDESCAT_LOGICAL_URL_MAX_BYTES,
    );
    expect(request.requestMethod).toBe("GET");
    expect(request.request.url.toString()).toBe(request.logicalRequestUrl.toString());
    expect(request.logicalRequestUrl.toString()).toContain("?lang=en&A=1%2C3&AA=4&B=2&K=");
    expect(request.logicalRequestUrl.searchParams.get("_LAST_")).toBe("2");
    expect(request.logicalRequestUrl.searchParams.get("A")).toBe("1,3");
    expect(request.logicalRequestUrl.searchParams.get("AA")).toBe("4");
    expect(request.logicalRequestUrl.searchParams.get("B")).toBe("2");
    expect(request.logicalRequestUrl.searchParams.get("K")).toBe(
      Array(8).fill("x".repeat(240)).join(","),
    );
    expect(request.request.body).toBeUndefined();
    expect(request).not.toHaveProperty("requestBodyParams");
  });

  it("reports filter_count cap details", () => {
    const filters = Object.fromEntries(
      Array.from({ length: IDESCAT_FILTER_COUNT_MAX + 1 }, (_, index) => [`K${index}`, "x"]),
    );

    expectCapError(
      () => buildIdescatDataRequest({ ...baseInput, filters }),
      "filter_count",
      IDESCAT_FILTER_COUNT_MAX + 1,
      IDESCAT_FILTER_COUNT_MAX,
    );
  });

  it("reports filter_key_bytes cap details", () => {
    expectCapError(
      () =>
        buildIdescatDataRequest({
          ...baseInput,
          filters: {
            ["K".repeat(IDESCAT_FILTER_KEY_MAX_BYTES + 1)]: "x",
          },
        }),
      "filter_key_bytes",
      IDESCAT_FILTER_KEY_MAX_BYTES + 1,
      IDESCAT_FILTER_KEY_MAX_BYTES,
    );
  });

  it("reports filter_value_bytes cap details", () => {
    expectCapError(
      () =>
        buildIdescatDataRequest({
          ...baseInput,
          filters: {
            K: "x".repeat(IDESCAT_FILTER_VALUE_MAX_BYTES + 1),
          },
        }),
      "filter_value_bytes",
      IDESCAT_FILTER_VALUE_MAX_BYTES + 1,
      IDESCAT_FILTER_VALUE_MAX_BYTES,
    );
  });

  it("reports filter_total_bytes cap details", () => {
    const filters = {
      A: Array(17).fill("x".repeat(241)),
    };
    const observed = getUtf8ByteLength("A") + 17 * getUtf8ByteLength("x".repeat(241));

    expectCapError(
      () => buildIdescatDataRequest({ ...baseInput, filters }),
      "filter_total_bytes",
      observed,
      IDESCAT_FILTER_TOTAL_MAX_BYTES,
    );
  });

  it("reports logical_url_bytes for URL-encoded payloads within the filter cap", () => {
    const filters = {
      A: Array(15).fill("é".repeat(128)),
    };
    const observed = getUrlByteLength(createLogicalUrl(filters));
    const filterByteLength = getUtf8ByteLength("A") + 15 * getUtf8ByteLength("é".repeat(128));

    expect(observed).toBeGreaterThan(IDESCAT_LOGICAL_URL_MAX_BYTES);
    expect(filterByteLength).toBeLessThanOrEqual(IDESCAT_FILTER_TOTAL_MAX_BYTES);
    expectCapError(
      () => buildIdescatDataRequest({ ...baseInput, filters }),
      "logical_url_bytes",
      observed,
      IDESCAT_LOGICAL_URL_MAX_BYTES,
    );
  });
});

function createLogicalUrl(filters: Record<string, string | string[]>): URL {
  const url = new URL("https://api.idescat.cat/taules/v2/pmh/1180/8078/com/data?lang=en");

  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  return url;
}

function expectCapError(run: () => unknown, rule: string, observed: number, limit: number): void {
  try {
    run();
    throw new Error("Expected buildIdescatDataRequest to throw.");
  } catch (error) {
    expect(error).toBeInstanceOf(IdescatError);
    expect(error).toMatchObject({
      code: "invalid_input",
      source_error: {
        rule,
        observed,
        limit,
      },
    });
  }
}
