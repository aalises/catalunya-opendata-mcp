import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { type JsonValue, toJsonSafeValue } from "../common/json-safe.js";
import { formatZodError } from "../common/zod.js";
import {
  type BcnDatasetProvenance,
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  fetchBcnPackageData,
  getBcnLicenseOrTerms,
  normalizeBcnId,
} from "./catalog.js";
import {
  BcnError,
  buildBcnActionUrl,
  buildBcnDatastoreUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
} from "./client.js";

export interface BcnResourceInfoInput {
  resource_id: string;
}

export interface BcnDatastoreField {
  id: string;
  type: string;
}

export interface BcnResourceMetadata {
  datastore_active: boolean;
  description: string | null;
  format: string | null;
  last_modified: string | null;
  license_or_terms: string | null;
  mimetype: string | null;
  name: string;
  package_id: string | null;
  package_title: string | null;
  resource_id: string;
  url: string | null;
  provenance: BcnDatasetProvenance;
}

export interface BcnResourceInfoData extends BcnResourceMetadata {
  fields: BcnDatastoreField[] | null;
  fields_unavailable_reason?: string;
  suggested_next_action: string;
}

export interface BcnResourceMetadataEnrichment {
  includePackageTitle?: boolean;
}

export interface BcnResourceInfoResult {
  data: BcnResourceInfoData;
  provenance: BcnOperationProvenance;
}

const resourceShowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    datastore_active: z.boolean().optional(),
    format: z.string().nullable().optional(),
    last_modified: z.string().nullable().optional(),
    mimetype: z.string().nullable().optional(),
    package_id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    license_id: z.string().nullable().optional(),
    license_title: z.string().nullable().optional(),
    license_url: z.string().nullable().optional(),
  })
  .passthrough();

const datastoreSchemaSchema = z
  .object({
    fields: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type RawResource = z.infer<typeof resourceShowSchema>;

export async function getBcnResourceInfo(
  input: BcnResourceInfoInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnResourceInfoResult> {
  const resourceId = normalizeBcnId("resource_id", input.resource_id);
  const url = buildBcnActionUrl("resource_show", { id: resourceId });
  const raw = await fetchBcnActionResult({ url }, config, options);
  const metadata = await enrichResourceMetadata(parseResource(raw), config, options);
  const fieldsResult = metadata.datastore_active
    ? await tryGetBcnDatastoreFields(resourceId, config, options)
    : { fields: null };

  return {
    data: {
      ...metadata,
      fields: fieldsResult.fields,
      ...(fieldsResult.unavailable_reason
        ? { fields_unavailable_reason: fieldsResult.unavailable_reason }
        : {}),
      suggested_next_action: getSuggestedNextAction(metadata.datastore_active, fieldsResult),
    },
    provenance: createBcnOperationProvenance("resource_show", url),
  };
}

export async function fetchBcnResourceMetadata(
  resourceId: string,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
  enrichment: BcnResourceMetadataEnrichment = {},
): Promise<BcnResourceMetadata> {
  const normalizedResourceId = normalizeBcnId("resource_id", resourceId);
  const url = buildBcnActionUrl("resource_show", { id: normalizedResourceId });
  const raw = await fetchBcnActionResult({ url }, config, options);
  return enrichResourceMetadata(parseResource(raw), config, options, enrichment);
}

export async function getBcnDatastoreFields(
  resourceId: string,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnDatastoreField[]> {
  const url = buildBcnDatastoreUrl("datastore_search");
  const raw = await fetchBcnActionResult(
    {
      method: "POST",
      url,
      body: {
        resource_id: normalizeBcnId("resource_id", resourceId),
        limit: 0,
      },
    },
    config,
    options,
  );
  const parsed = datastoreSchemaSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN datastore schema response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return parsed.data.fields.map((field) => ({ id: field.id, type: field.type }));
}

function parseResource(raw: unknown): RawResource {
  const parsed = resourceShowSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN resource_show response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

async function enrichResourceMetadata(
  resource: RawResource,
  config: AppConfig,
  options: FetchBcnJsonOptions,
  enrichment: BcnResourceMetadataEnrichment = {},
): Promise<BcnResourceMetadata> {
  const includePackageTitle = enrichment.includePackageTitle ?? true;
  const packageId = normalizeNullableString(resource.package_id);
  let packageTitle: string | null = null;
  let packageLicense = getBcnLicenseOrTerms(resource);
  const needsPackageFetch = Boolean(packageId) && (includePackageTitle || !packageLicense);

  if (packageId && needsPackageFetch) {
    try {
      const pkg = await fetchBcnPackageData(packageId, config, options);
      packageTitle = pkg.title;
      packageLicense = packageLicense ?? pkg.license_or_terms;
    } catch {
      // Resource metadata remains useful even when the parent package lookup is degraded.
    }
  }

  const sourceUrl = packageId
    ? `https://opendata-ajuntament.barcelona.cat/data/dataset/${packageId}/resource/${resource.id}`
    : "https://opendata-ajuntament.barcelona.cat/data/";

  return {
    resource_id: resource.id,
    package_id: packageId,
    package_title: packageTitle,
    name: normalizeNullableString(resource.name) ?? resource.id,
    description: normalizeNullableString(resource.description),
    datastore_active: resource.datastore_active ?? false,
    format: normalizeNullableString(resource.format),
    last_modified: normalizeNullableString(resource.last_modified),
    license_or_terms: packageLicense,
    mimetype: normalizeNullableString(resource.mimetype),
    url: normalizeNullableString(resource.url),
    provenance: {
      source: "bcn",
      source_url: sourceUrl,
      id: resource.id,
      last_updated: normalizeNullableString(resource.last_modified),
      license_or_terms: packageLicense,
      language: "ca",
    },
  };
}

interface DatastoreFieldsAttempt {
  fields: BcnDatastoreField[] | null;
  unavailable_reason?: string;
}

async function tryGetBcnDatastoreFields(
  resourceId: string,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<DatastoreFieldsAttempt> {
  try {
    return { fields: await getBcnDatastoreFields(resourceId, config, options) };
  } catch (error) {
    return {
      fields: null,
      unavailable_reason:
        error instanceof BcnError ? error.message : "DataStore schema fetch failed.",
    };
  }
}

function getSuggestedNextAction(
  datastoreActive: boolean,
  fieldsResult: DatastoreFieldsAttempt,
): string {
  if (!datastoreActive) {
    return "Use bcn_preview_resource for a bounded CSV/JSON download preview; this resource is not DataStore-active.";
  }

  if (fieldsResult.fields) {
    return "Use bcn_query_resource with returned field IDs for filters, fields, and sort.";
  }

  return "DataStore is active but the field schema is temporarily unavailable; retry bcn_get_resource_info or call bcn_query_resource with cautious filters.";
}

export function normalizeBcnJsonObject(value: unknown, name: string): Record<string, JsonValue> {
  if (!isPlainRecord(value)) {
    throw new BcnError("invalid_input", `${name} must be a plain object.`);
  }

  const normalized = toJsonSafeValue(value);

  if (!isPlainJsonRecord(normalized)) {
    throw new BcnError("invalid_input", `${name} must contain only JSON-safe values.`);
  }

  return normalized;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isPlainJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
