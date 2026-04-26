import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import {
  type SocrataSearchDatasetsInput,
  searchSocrataDatasets,
} from "../../../src/sources/socrata/catalog.js";
import {
  SOCRATA_CATALOG_BASE_URL,
  SOCRATA_CATALOG_DOMAIN,
  SOCRATA_USER_AGENT,
} from "../../../src/sources/socrata/client.js";

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

const baseInput: SocrataSearchDatasetsInput = {
  query: "habitatge",
  limit: 2,
  offset: 5,
};

describe("searchSocrataDatasets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a catalog v1 request with the Generalitat domain, pagination, and headers", async () => {
    const fetchMock = mockCatalogResponse({
      resultSetSize: 1,
      results: [catalogResult()],
    });

    await searchSocrataDatasets(baseInput, {
      ...baseConfig,
      socrataAppToken: "token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(requestUrl.toString());
    expect(`${url.origin}${url.pathname}`).toBe(SOCRATA_CATALOG_BASE_URL);
    expect(url.searchParams.get("domains")).toBe(SOCRATA_CATALOG_DOMAIN);
    expect(url.searchParams.get("only")).toBe("dataset");
    expect(url.searchParams.get("q")).toBe("habitatge");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("offset")).toBe("5");
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": SOCRATA_USER_AGENT,
      "X-App-Token": "token",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps successful catalog results into dataset cards with operation and card provenance", async () => {
    const fetchMock = mockCatalogResponse({
      resultSetSize: 2,
      results: [
        catalogResult({
          metadata: { domain: SOCRATA_CATALOG_DOMAIN, license: "See Terms of Use" },
        }),
        catalogResult({
          metadata: { domain: SOCRATA_CATALOG_DOMAIN },
          permalink: null,
          link: "https://analisi.transparenciacatalunya.cat/Habitatge/another/abcd-1234",
          resource: {
            id: "abcd-1234",
            name: "Second dataset",
            description: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        }),
      ],
    });

    const result = await searchSocrataDatasets(baseInput, baseConfig);

    expect(result).toEqual({
      data: {
        query: "habitatge",
        limit: 2,
        offset: 5,
        total: 2,
        results: [
          {
            title: "Habitatge public",
            description: "Dataset about housing.",
            source_id: "v8i4-fa4q",
            source_domain: SOCRATA_CATALOG_DOMAIN,
            api_endpoint: `https://${SOCRATA_CATALOG_DOMAIN}/resource/v8i4-fa4q.json`,
            web_url: `https://${SOCRATA_CATALOG_DOMAIN}/d/v8i4-fa4q`,
            updated_at: "2026-03-18T10:27:52.000Z",
            provenance: {
              source: "socrata",
              source_url: `https://${SOCRATA_CATALOG_DOMAIN}/d/v8i4-fa4q`,
              id: "v8i4-fa4q",
              last_updated: "2026-03-18T10:27:52.000Z",
              license_or_terms: "See Terms of Use",
              language: "ca",
            },
          },
          {
            title: "Second dataset",
            description: null,
            source_id: "abcd-1234",
            source_domain: SOCRATA_CATALOG_DOMAIN,
            api_endpoint: `https://${SOCRATA_CATALOG_DOMAIN}/resource/abcd-1234.json`,
            web_url: "https://analisi.transparenciacatalunya.cat/Habitatge/another/abcd-1234",
            updated_at: "2026-04-01T00:00:00.000Z",
            provenance: {
              source: "socrata",
              source_url: "https://analisi.transparenciacatalunya.cat/Habitatge/another/abcd-1234",
              id: "abcd-1234",
              last_updated: "2026-04-01T00:00:00.000Z",
              license_or_terms: null,
              language: "ca",
            },
          },
        ],
      },
      provenance: {
        source: "socrata",
        source_url: (fetchMock.mock.calls[0]?.[0] as URL).toString(),
        id: "analisi.transparenciacatalunya.cat:catalog_search",
        last_updated: null,
        license_or_terms: null,
        language: "ca",
      },
    });
  });

  it("combines caller cancellation with the configured request timeout", async () => {
    const controller = new AbortController();
    controller.abort("client cancelled");
    const fetchMock = mockCatalogResponse({
      resultSetSize: 1,
      results: [catalogResult()],
    });

    await searchSocrataDatasets(baseInput, baseConfig, {
      signal: controller.signal,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });

  it("requires updatedAt on catalog resources", async () => {
    const resultWithoutUpdatedAt: Record<string, unknown> = catalogResult();
    delete (resultWithoutUpdatedAt.resource as Record<string, unknown>).updatedAt;

    mockCatalogResponse({
      resultSetSize: 1,
      results: [resultWithoutUpdatedAt],
    });

    await expect(searchSocrataDatasets(baseInput, baseConfig)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("converts non-2xx responses into typed Socrata HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), {
        headers: { "Content-Type": "application/json" },
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

    await expect(searchSocrataDatasets(baseInput, baseConfig)).rejects.toMatchObject({
      code: "http_error",
      retryable: true,
      status: 429,
    });
  });

  it("converts rejected fetches into typed network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket closed"));

    await expect(searchSocrataDatasets(baseInput, baseConfig)).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });

  it("converts timeout-like aborts into typed timeout errors", async () => {
    const timeoutError = new Error("deadline exceeded");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);

    await expect(searchSocrataDatasets(baseInput, baseConfig)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });
});

function mockCatalogResponse(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
}

function catalogResult(overrides: Record<string, unknown> = {}) {
  return {
    resource: {
      id: "v8i4-fa4q",
      name: "Habitatge public",
      description: "Dataset about housing.",
      updatedAt: "2026-03-18T10:27:52.000Z",
      ...((overrides.resource as Record<string, unknown> | undefined) ?? {}),
    },
    metadata: {
      domain: SOCRATA_CATALOG_DOMAIN,
      license: "See Terms of Use",
      ...((overrides.metadata as Record<string, unknown> | undefined) ?? {}),
    },
    link: `https://${SOCRATA_CATALOG_DOMAIN}/Habitatge/Habitatge-public/v8i4-fa4q`,
    permalink: `https://${SOCRATA_CATALOG_DOMAIN}/d/v8i4-fa4q`,
    ...overrides,
  };
}
