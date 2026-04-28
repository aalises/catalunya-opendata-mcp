import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBcnPackage,
  normalizeBcnId,
  searchBcnPackages,
} from "../../../src/sources/bcn/catalog.js";
import { getBcnResourceInfo } from "../../../src/sources/bcn/resource.js";
import {
  baseConfig,
  bcnPackage,
  bcnResource,
  ckanFailure,
  ckanSuccess,
  mockFetchResponses,
} from "./helpers.js";

describe("Open Data BCN catalog and resource metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches packages and maps package cards with license and resources", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess({
        count: 1,
        results: [bcnPackage()],
      }),
    );

    const result = await searchBcnPackages({ query: "arbrat", limit: 5, offset: 10 }, baseConfig);

    const [requestUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(requestUrl.toString());
    expect(url.pathname).toMatch(/\/package_search$/u);
    expect(url.searchParams.get("q")).toBe("arbrat");
    expect(url.searchParams.get("rows")).toBe("5");
    expect(url.searchParams.get("start")).toBe("10");
    expect(result.data).toMatchObject({
      query: "arbrat",
      limit: 5,
      offset: 10,
      total: 1,
      results: [
        {
          package_id: "package-1",
          title: "Package title",
          license_or_terms: "CC BY 4.0",
          resource_count: 1,
          resources: [
            {
              resource_id: "resource-1",
              datastore_active: false,
              format: "CSV",
            },
          ],
        },
      ],
    });
  });

  it("gets package resources and tags", async () => {
    mockFetchResponses(ckanSuccess(bcnPackage()));

    const result = await getBcnPackage({ package_id: " package-1 " }, baseConfig);

    expect(result.data).toMatchObject({
      package_id: "package-1",
      tags: ["Trees"],
      license_or_terms: "CC BY 4.0",
    });
  });

  it("gets active DataStore resource info and schema fields", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          datastore_active: true,
          package_id: "package-1",
          license_title: null,
        }),
      ),
      ckanSuccess(bcnPackage({ id: "package-1", title: "Parent package" })),
      ckanSuccess({
        fields: [
          { id: "_id", type: "int" },
          { id: "Nom", type: "text" },
        ],
      }),
    );

    const result = await getBcnResourceInfo({ resource_id: "resource-1" }, baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, schemaInit] = fetchMock.mock.calls[2] as [URL, RequestInit];
    expect(schemaInit.method).toBe("POST");
    expect(JSON.parse(String(schemaInit.body))).toEqual({
      resource_id: "resource-1",
      limit: 0,
    });
    expect(result.data).toMatchObject({
      resource_id: "resource-1",
      datastore_active: true,
      package_id: "package-1",
      package_title: "Parent package",
      license_or_terms: "CC BY 4.0",
      fields: [
        { id: "_id", type: "int" },
        { id: "Nom", type: "text" },
      ],
      suggested_next_action: expect.stringContaining("bcn_query_resource"),
    });
  });

  it("returns active DataStore resource info when the schema fetch fails", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          datastore_active: true,
          package_id: null,
          license_title: "Resource terms",
        }),
      ),
      ckanFailure({ message: "datastore unavailable" }),
    );

    const result = await getBcnResourceInfo({ resource_id: "resource-1" }, baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data).toMatchObject({
      datastore_active: true,
      fields: null,
      fields_unavailable_reason: expect.stringContaining("datastore"),
      suggested_next_action: expect.stringContaining("temporarily unavailable"),
    });
  });

  it("returns resource metadata even when parent package enrichment fails", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          package_id: "package-1",
          license_title: "Resource terms",
        }),
      ),
      ckanFailure({ message: "package unavailable" }),
    );

    const result = await getBcnResourceInfo({ resource_id: "resource-1" }, baseConfig);

    expect(result.data).toMatchObject({
      package_id: "package-1",
      package_title: null,
      license_or_terms: "Resource terms",
      fields: null,
    });
  });

  it("does not fabricate dataset resource URLs when package_id is absent", async () => {
    mockFetchResponses(ckanSuccess(bcnResource({ package_id: null })));

    const result = await getBcnResourceInfo({ resource_id: "resource-1" }, baseConfig);

    expect(result.data.provenance.source_url).toBe(
      "https://opendata-ajuntament.barcelona.cat/data/",
    );
  });

  it("validates BCN identifiers after trimming", () => {
    expect(normalizeBcnId("resource_id", " resource-1 ")).toBe("resource-1");

    for (const value of ["", "resource/1", "resource 1", "../resource", "x".repeat(129)]) {
      expect(() => normalizeBcnId("resource_id", value)).toThrow(/safe Open Data BCN/);
    }
  });
});
