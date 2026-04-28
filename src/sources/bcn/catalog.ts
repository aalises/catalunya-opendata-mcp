import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { SourceDatasetProvenance, SourceOperationProvenance } from "../common/provenance.js";
import { formatZodError } from "../common/zod.js";
import {
  BcnError,
  buildBcnActionUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
} from "./client.js";

export type BcnOperationProvenance = SourceOperationProvenance<"bcn">;
export type BcnDatasetProvenance = SourceDatasetProvenance<"bcn">;

export interface BcnSearchPackagesInput {
  limit: number;
  offset: number;
  query: string;
}

export interface BcnGetPackageInput {
  package_id: string;
}

export interface BcnResourceSummary {
  datastore_active: boolean;
  description: string | null;
  format: string | null;
  last_modified: string | null;
  mimetype: string | null;
  name: string;
  resource_id: string;
  url: string | null;
}

export interface BcnPackageCard {
  description: string | null;
  license_or_terms: string | null;
  metadata_modified: string | null;
  name: string;
  package_id: string;
  resource_count: number;
  resources: BcnResourceSummary[];
  source_url: string;
  title: string;
  provenance: BcnDatasetProvenance;
}

export interface BcnSearchPackagesData {
  limit: number;
  offset: number;
  query: string;
  results: BcnPackageCard[];
  total: number;
}

export interface BcnSearchPackagesResult {
  data: BcnSearchPackagesData;
  provenance: BcnOperationProvenance;
}

export interface BcnPackageData extends BcnPackageCard {
  tags: string[];
}

export interface BcnGetPackageResult {
  data: BcnPackageData;
  provenance: BcnOperationProvenance;
}

const packageSearchSchema = z
  .object({
    count: z.number().int().nonnegative(),
    results: z.array(z.unknown()),
  })
  .passthrough();

const packageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    title: z.string().min(1),
    notes: z.string().nullable().optional(),
    license_id: z.string().nullable().optional(),
    license_title: z.string().nullable().optional(),
    license_url: z.string().nullable().optional(),
    metadata_modified: z.string().nullable().optional(),
    resources: z.array(z.unknown()).default([]),
    tags: z
      .array(
        z
          .object({
            display_name: z.string().nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const resourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    datastore_active: z.boolean().optional(),
    format: z.string().nullable().optional(),
    last_modified: z.string().nullable().optional(),
    mimetype: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

export async function searchBcnPackages(
  input: BcnSearchPackagesInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnSearchPackagesResult> {
  const normalized = normalizeSearchInput(input, config);
  const url = buildBcnActionUrl("package_search", {
    q: normalized.query,
    rows: String(normalized.limit),
    start: String(normalized.offset),
  });
  const raw = await fetchBcnActionResult({ url }, config, options);
  const parsed = packageSearchSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN package_search response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return {
    data: {
      ...normalized,
      total: parsed.data.count,
      results: parsed.data.results.map(parsePackage).map(toPackageCard),
    },
    provenance: createBcnOperationProvenance("package_search", url),
  };
}

export async function getBcnPackage(
  input: BcnGetPackageInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnGetPackageResult> {
  const packageId = normalizeBcnId("package_id", input.package_id);
  const url = buildBcnActionUrl("package_show", { id: packageId });
  const raw = await fetchBcnActionResult({ url }, config, options);
  const data = toPackageData(parsePackage(raw));

  return {
    data,
    provenance: createBcnOperationProvenance("package_show", url),
  };
}

export async function fetchBcnPackageData(
  packageId: string,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnPackageData> {
  return (await getBcnPackage({ package_id: packageId }, config, options)).data;
}

export function createBcnOperationProvenance(
  operation: string,
  sourceUrl = buildBcnActionUrl("package_search"),
): BcnOperationProvenance {
  return {
    source: "bcn",
    source_url: sourceUrl.toString(),
    id: `opendata-ajuntament.barcelona.cat:${operation}`,
    last_updated: null,
    license_or_terms: null,
    language: "ca",
  };
}

export function normalizeBcnId(name: string, value: string): string {
  const trimmed = value.trim();

  if (!trimmed || /[\s/?#%]/u.test(trimmed) || trimmed.includes("..") || trimmed.length > 128) {
    throw new BcnError("invalid_input", `${name} is not a safe Open Data BCN identifier.`);
  }

  return trimmed;
}

export function getBcnLicenseOrTerms(value: {
  license_id?: string | null;
  license_title?: string | null;
  license_url?: string | null;
}): string | null {
  return (
    normalizeNullableString(value.license_title) ??
    normalizeNullableString(value.license_id) ??
    normalizeNullableString(value.license_url)
  );
}

function normalizeSearchInput(
  input: BcnSearchPackagesInput,
  config: AppConfig,
): BcnSearchPackagesInput {
  const query = input.query.trim();

  if (!query) {
    throw new BcnError("invalid_input", "query must not be empty.");
  }

  return {
    query,
    limit: normalizeLimit(input.limit, config.maxResults, 10),
    offset: normalizeOffset(input.offset),
  };
}

export function normalizeLimit(
  limit: number | undefined,
  maxResults: number,
  fallback: number,
): number {
  const normalized = limit ?? Math.min(fallback, maxResults);

  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new BcnError("invalid_input", "limit must be a safe integer greater than or equal to 1.");
  }

  if (normalized > maxResults) {
    throw new BcnError(
      "invalid_input",
      `limit ${normalized} exceeds the configured maximum of ${maxResults}.`,
    );
  }

  return normalized;
}

export function normalizeOffset(offset: number | undefined): number {
  const normalized = offset ?? 0;

  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new BcnError("invalid_input", "offset must be a non-negative safe integer.");
  }

  return normalized;
}

function parsePackage(raw: unknown): z.infer<typeof packageSchema> {
  const parsed = packageSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN package metadata: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

function parseResource(raw: unknown): z.infer<typeof resourceSchema> {
  const parsed = resourceSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN resource metadata: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

function toPackageCard(pkg: z.infer<typeof packageSchema>): BcnPackageCard {
  const sourceUrl = `https://opendata-ajuntament.barcelona.cat/data/dataset/${pkg.id}`;
  const licenseOrTerms = getBcnLicenseOrTerms(pkg);
  const resources = pkg.resources.map(parseResource).map(toResourceSummary);

  return {
    package_id: pkg.id,
    name: pkg.name,
    title: pkg.title,
    description: normalizeNullableString(pkg.notes),
    license_or_terms: licenseOrTerms,
    metadata_modified: normalizeNullableString(pkg.metadata_modified),
    resource_count: resources.length,
    resources,
    source_url: sourceUrl,
    provenance: {
      source: "bcn",
      source_url: sourceUrl,
      id: pkg.id,
      last_updated: normalizeNullableString(pkg.metadata_modified),
      license_or_terms: licenseOrTerms,
      language: "ca",
    },
  };
}

function toPackageData(pkg: z.infer<typeof packageSchema>): BcnPackageData {
  return {
    ...toPackageCard(pkg),
    tags: pkg.tags.flatMap((tag) => {
      const value = normalizeNullableString(tag.display_name) ?? normalizeNullableString(tag.name);
      return value ? [value] : [];
    }),
  };
}

function toResourceSummary(resource: z.infer<typeof resourceSchema>): BcnResourceSummary {
  return {
    resource_id: resource.id,
    name: normalizeNullableString(resource.name) ?? resource.id,
    description: normalizeNullableString(resource.description),
    datastore_active: resource.datastore_active ?? false,
    format: normalizeNullableString(resource.format),
    last_modified: normalizeNullableString(resource.last_modified),
    mimetype: normalizeNullableString(resource.mimetype),
    url: normalizeNullableString(resource.url),
  };
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
