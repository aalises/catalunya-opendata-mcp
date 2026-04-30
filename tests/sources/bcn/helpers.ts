import { vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import {
  BCN_PLACE_REGISTRY,
  type BcnPlaceRegistryResource,
} from "../../../src/sources/bcn/place.js";

export const BCN_PLACE_REGISTRY_SNAPSHOT: readonly BcnPlaceRegistryResource[] = [
  ...BCN_PLACE_REGISTRY,
];

export const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  idescatUpstreamReadBytes: 8_388_608,
  bcnUpstreamReadBytes: 2_097_152,
  bcnGeoScanMaxRows: 10_000,
  bcnGeoScanBytes: 67_108_864,
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

export function setBcnPlaceRegistry(resources: BcnPlaceRegistryResource[]): void {
  BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...resources);
}

export function resetBcnPlaceRegistry(): void {
  BCN_PLACE_REGISTRY.splice(0, BCN_PLACE_REGISTRY.length, ...BCN_PLACE_REGISTRY_SNAPSHOT);
}

export function mustFindBcnPlaceRegistryResource(resourceId: string): BcnPlaceRegistryResource {
  const resource = BCN_PLACE_REGISTRY_SNAPSHOT.find(
    (candidate) => candidate.resourceId === resourceId,
  );

  if (resource === undefined) {
    throw new Error(`Missing BCN place registry resource ${resourceId}.`);
  }

  return resource;
}

export function smallPolygon(): string {
  return "POLYGON ((2.10 41.40, 2.20 41.40, 2.20 41.50, 2.10 41.50, 2.10 41.40))";
}
