import { afterEach, describe, expect, it, vi } from "vitest";

import { isAllowedBcnDownloadUrl, previewBcnResource } from "../../../src/sources/bcn/preview.js";
import { baseConfig, bcnResource, ckanSuccess, mockFetchResponses } from "./helpers.js";

describe("previewBcnResource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-BCN and non-HTTPS download URLs before fetching them", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://evil.example/resource.csv",
        }),
      ),
    );

    await expect(
      previewBcnResource({ resource_id: "resource-1" }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("opendata-ajuntament.barcelona.cat"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(
      isAllowedBcnDownloadUrl(
        new URL("https://opendata-ajuntament.barcelona.cat/download/resource.csv"),
      ),
    ).toBe(true);
    expect(
      isAllowedBcnDownloadUrl(
        new URL("https://static.opendata-ajuntament.barcelona.cat/download/resource.csv"),
      ),
    ).toBe(true);
    expect(isAllowedBcnDownloadUrl(new URL("http://opendata-ajuntament.barcelona.cat/a.csv"))).toBe(
      false,
    );
  });

  it("validates every manual redirect hop against the same allowlist", async () => {
    const fetchMock = mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://opendata-ajuntament.barcelona.cat/download/start.csv",
        }),
      ),
      new Response(null, {
        headers: { Location: "https://evil.example/resource.csv" },
        status: 302,
      }),
    );

    await expect(
      previewBcnResource({ resource_id: "resource-1" }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses UTF-8 BOM semicolon CSV previews", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          format: "CSV",
          mimetype: "text/csv",
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.csv",
        }),
      ),
      new Response("\uFEFFNom;Barri\nArbre;Gracia\nFont;Sants\n", {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
        status: 200,
      }),
    );

    const result = await previewBcnResource({ resource_id: "resource-1", limit: 10 }, baseConfig);

    expect(result.data).toMatchObject({
      format: "csv",
      delimiter: ";",
      charset: "utf-8",
      columns: ["Nom", "Barri"],
      row_count: 2,
      truncated: false,
      rows: [
        { Nom: "Arbre", Barri: "Gracia" },
        { Nom: "Font", Barri: "Sants" },
      ],
    });
  });

  it("falls back to windows-1252 when CSV bytes are not UTF-8", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.csv",
        }),
      ),
      new Response(Buffer.from("Nom;Barri\ncaf\xe9;Gr\xe0cia\n", "latin1"), {
        headers: { "Content-Type": "text/csv" },
        status: 200,
      }),
    );

    const result = await previewBcnResource({ resource_id: "resource-1" }, baseConfig);

    expect(result.data.charset).toBe("windows-1252");
    expect(result.data.rows).toEqual([{ Nom: "café", Barri: "Gràcia" }]);
  });

  it("trims capped CSV bytes to the last complete row before parsing", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.csv",
        }),
      ),
      new Response("A;B\n1;one\n2;two\n3;three\n", {
        headers: { "Content-Type": "text/csv" },
        status: 200,
      }),
    );

    const result = await previewBcnResource(
      { resource_id: "resource-1", limit: 10 },
      { ...baseConfig, bcnUpstreamReadBytes: 18 },
    );

    expect(result.data).toMatchObject({
      truncated: true,
      truncation_reason: "byte_cap",
      row_count: 2,
      rows: [
        { A: "1", B: "one" },
        { A: "2", B: "two" },
      ],
    });
  });

  it("parses JSON array previews and applies row caps", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          format: "JSON",
          mimetype: "application/json",
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.json",
        }),
      ),
      new Response(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    const result = await previewBcnResource({ resource_id: "resource-1", limit: 2 }, baseConfig);

    expect(result.data).toMatchObject({
      format: "json",
      columns: ["id"],
      row_count: 2,
      truncated: true,
      truncation_reason: "row_cap",
      rows: [{ id: 1 }, { id: 2 }],
    });
  });

  it("treats non-object JSON preview rows as invalid upstream responses", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          format: "JSON",
          mimetype: "application/json",
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.json",
        }),
      ),
      new Response(JSON.stringify([1, 2, 3]), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      previewBcnResource({ resource_id: "resource-1" }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining("JSON object"),
    });
  });

  it("returns an unsupported-format error for non-CSV/JSON downloads", async () => {
    mockFetchResponses(
      ckanSuccess(
        bcnResource({
          format: "ZIP",
          mimetype: "application/zip",
          url: "https://opendata-ajuntament.barcelona.cat/download/resource.zip",
        }),
      ),
      new Response("zip", {
        headers: { "Content-Type": "application/zip" },
        status: 200,
      }),
    );

    await expect(
      previewBcnResource({ resource_id: "resource-1" }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("CSV and JSON"),
    });
  });
});
