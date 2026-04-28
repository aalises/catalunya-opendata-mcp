import { vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";

export const baseConfig: AppConfig = {
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

export function ckanSuccess(result: unknown): Response {
  return jsonResponse({ success: true, result });
}

export function ckanFailure(error: unknown): Response {
  return jsonResponse({ success: false, error });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

export function mockFetchResponses(...responses: Response[]) {
  const fetchMock = vi.spyOn(globalThis, "fetch");

  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }

  return fetchMock;
}

export function bcnResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    name: "Resource 1",
    description: "Resource description",
    datastore_active: false,
    format: "CSV",
    last_modified: "2024-01-01T00:00:00",
    mimetype: "text/csv",
    package_id: null,
    url: "https://opendata-ajuntament.barcelona.cat/download/resource-1.csv",
    ...overrides,
  };
}

export function bcnPackage(overrides: Record<string, unknown> = {}) {
  return {
    id: "package-1",
    name: "package-name",
    title: "Package title",
    notes: "Package description",
    license_id: "cc-by",
    license_title: "CC BY 4.0",
    license_url: "https://example.test/license",
    metadata_modified: "2024-01-02T00:00:00",
    resources: [bcnResource({ package_id: "package-1" })],
    tags: [{ display_name: "Trees" }],
    ...overrides,
  };
}
