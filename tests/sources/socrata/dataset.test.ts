import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import { SOCRATA_CATALOG_DOMAIN, SOCRATA_USER_AGENT } from "../../../src/sources/socrata/client.js";
import {
  describeSocrataDataset,
  type SocrataDescribeDatasetInput,
} from "../../../src/sources/socrata/dataset.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  socrataAppToken: undefined,
};

const baseInput: SocrataDescribeDatasetInput = {
  source_id: "v8i4-fa4q",
};

describe("describeSocrataDataset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a view metadata request with the Generalitat domain and headers", async () => {
    const fetchMock = mockViewResponse(viewMetadata());

    await describeSocrataDataset(baseInput, {
      ...baseConfig,
      socrataAppToken: "token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe(`https://${SOCRATA_CATALOG_DOMAIN}/api/views/v8i4-fa4q`);
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": SOCRATA_USER_AGENT,
      "X-App-Token": "token",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps successful view metadata into a dataset description", async () => {
    const fetchMock = mockViewResponse(viewMetadata());

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result).toEqual({
      data: {
        title: "Habitatges amb protecció oficial",
        description: "Dataset about housing.",
        attribution: "Departament de Territori",
        attribution_link: "https://example.test/terms",
        license_or_terms: "See Terms of Use",
        category: "Habitatge",
        source_id: "v8i4-fa4q",
        source_domain: SOCRATA_CATALOG_DOMAIN,
        web_url: `https://${SOCRATA_CATALOG_DOMAIN}/d/v8i4-fa4q`,
        api_endpoint: `https://${SOCRATA_CATALOG_DOMAIN}/resource/v8i4-fa4q.json`,
        created_at: iso(1_700_000_000),
        published_at: iso(1_700_000_100),
        rows_updated_at: iso(1_700_000_300),
        view_last_modified: iso(1_700_000_200),
        columns: [
          {
            display_name: "Municipi",
            field_name: "municipi",
            datatype: "text",
            description: "Nom del municipi",
          },
          {
            display_name: "Notes",
            field_name: "notes",
            datatype: "text",
            description: null,
          },
        ],
        suggested_next_action:
          "Use the returned field_name values to build SODA $select, $where, and $order filters against api_endpoint.",
        provenance: {
          source: "socrata",
          source_url: `https://${SOCRATA_CATALOG_DOMAIN}/d/v8i4-fa4q`,
          id: "v8i4-fa4q",
          last_updated: iso(1_700_000_300),
          license_or_terms: "See Terms of Use",
          language: "ca",
        },
      },
      provenance: {
        source: "socrata",
        source_url: (fetchMock.mock.calls[0]?.[0] as URL).toString(),
        id: `${SOCRATA_CATALOG_DOMAIN}:dataset_describe`,
        last_updated: null,
        license_or_terms: null,
        language: "ca",
      },
    });
  });

  it("falls back to licenseId when no license object is present", async () => {
    mockViewResponse(
      viewMetadata({
        license: undefined,
        licenseId: "CUSTOM_LICENSE",
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data.license_or_terms).toBe("CUSTOM_LICENSE");
    expect(result.data.provenance.license_or_terms).toBe("CUSTOM_LICENSE");
  });

  it("treats SEE_TERMS_OF_USE as null when no license object is present", async () => {
    mockViewResponse(
      viewMetadata({
        attribution: "",
        attributionLink: "",
        description: "",
        license: undefined,
        licenseId: "SEE_TERMS_OF_USE",
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data).toMatchObject({
      description: null,
      attribution: null,
      attribution_link: null,
      license_or_terms: null,
    });
    expect(result.data.provenance.license_or_terms).toBeNull();
  });

  it("uses the timestamp fallback chain for provenance last_updated", async () => {
    mockViewResponse(
      viewMetadata({
        rowsUpdatedAt: undefined,
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data.provenance.last_updated).toBe(iso(1_700_000_200));
  });

  it("sets provenance last_updated to null when all timestamps are missing", async () => {
    mockViewResponse(
      viewMetadata({
        createdAt: undefined,
        publicationDate: undefined,
        rowsUpdatedAt: undefined,
        viewLastModified: undefined,
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data).toMatchObject({
      created_at: null,
      published_at: null,
      rows_updated_at: null,
      view_last_modified: null,
    });
    expect(result.data.provenance.last_updated).toBeNull();
  });

  it("rejects source_id values that do not match the four-by-four pattern", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));

    for (const sourceId of ["abc", "v8i4_fa4q", "V8I4-FA4Q", "../v8i4-fa4q", "v8i4-fa4q/"]) {
      await expect(
        describeSocrataDataset({ source_id: sourceId }, baseConfig),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects responses where view.id does not match the requested source_id", async () => {
    mockViewResponse(viewMetadata({ id: "haha-evil" }));

    await expect(describeSocrataDataset(baseInput, baseConfig)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("returns null timestamps when the epoch value overflows the JS Date range", async () => {
    mockViewResponse(
      viewMetadata({
        rowsUpdatedAt: undefined,
        viewLastModified: Number.MAX_SAFE_INTEGER,
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data.view_last_modified).toBeNull();
    expect(result.data.provenance.last_updated).toBe(iso(1_700_000_100));
  });

  it("falls back to licenseId when license.name is empty", async () => {
    mockViewResponse(
      viewMetadata({
        license: { name: "" },
        licenseId: "CC-BY",
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data.license_or_terms).toBe("CC-BY");
    expect(result.data.provenance.license_or_terms).toBe("CC-BY");
  });

  it("treats absent attribution, attribution_link, and category keys as null", async () => {
    mockViewResponse(
      viewMetadata({
        attribution: undefined,
        attributionLink: undefined,
        category: undefined,
      }),
    );

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data).toMatchObject({
      attribution: null,
      attribution_link: null,
      category: null,
    });
  });

  it("preserves an empty columns array", async () => {
    mockViewResponse(viewMetadata({ columns: [] }));

    const result = await describeSocrataDataset(baseInput, baseConfig);

    expect(result.data.columns).toEqual([]);
  });

  it("rejects invalid view metadata", async () => {
    mockViewResponse(
      viewMetadata({
        columns: [
          {
            name: "Municipi",
            dataTypeName: "text",
          },
        ],
      }),
    );

    await expect(describeSocrataDataset(baseInput, baseConfig)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("converts non-2xx responses into typed Socrata HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "not found" }), {
        headers: { "Content-Type": "application/json" },
        status: 404,
        statusText: "Not Found",
      }),
    );

    await expect(describeSocrataDataset(baseInput, baseConfig)).rejects.toMatchObject({
      code: "http_error",
      retryable: false,
      status: 404,
    });
  });

  it("converts rejected fetches into typed network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket closed"));

    await expect(describeSocrataDataset(baseInput, baseConfig)).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });

  it("converts timeout-like aborts into typed timeout errors", async () => {
    const timeoutError = new Error("deadline exceeded");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);

    await expect(describeSocrataDataset(baseInput, baseConfig)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });
});

function mockViewResponse(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
}

function viewMetadata(overrides: Record<string, unknown> = {}) {
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
        renderTypeName: "text",
      },
      {
        name: "Notes",
        dataTypeName: "text",
        description: "",
        fieldName: "notes",
        renderTypeName: "text",
      },
    ],
    ...overrides,
  };
}

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}
