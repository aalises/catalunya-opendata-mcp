import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength, getUtf8ByteLength } from "../common/caps.js";
import type { JsonValue } from "../common/json-safe.js";
import { formatZodError } from "../common/zod.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeBcnId,
  normalizeLimit,
  normalizeOffset,
} from "./catalog.js";
import {
  BcnError,
  buildBcnDatastoreUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
  isBcnError,
} from "./client.js";
import { fetchBcnResourceMetadata, normalizeBcnJsonObject } from "./resource.js";

export const BCN_QUERY_FILTER_TOTAL_MAX_BYTES = 16_384;
export const BCN_QUERY_TRUNCATION_HINTS = {
  byte_cap: "narrow filters, reduce fields, or lower limit",
  row_cap: "raise limit (within maxResults) or paginate with offset",
} as const satisfies Record<BcnQueryTruncationReason, string>;

export interface BcnQueryResourceInput {
  fields?: string[];
  filters?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  q?: string;
  resource_id: string;
  sort?: string;
}

export type BcnQueryTruncationReason = "byte_cap" | "row_cap";

export interface BcnQueryResourceData {
  fields: BcnDatastoreFieldOutput[];
  filters?: Record<string, JsonValue>;
  limit: number;
  offset: number;
  q?: string;
  request_body: Record<string, JsonValue>;
  request_method: "POST";
  request_url: string;
  resource_id: string;
  row_count: number;
  rows: Record<string, JsonValue>[];
  sort?: string;
  total: number | null;
  truncated: boolean;
  truncation_hint?: string;
  truncation_reason?: BcnQueryTruncationReason;
}

export interface BcnDatastoreFieldOutput {
  id: string;
  type: string;
}

export interface BcnQueryResourceResult {
  data: BcnQueryResourceData;
  provenance: BcnOperationProvenance;
}

interface NormalizedQueryInput {
  fields?: string[];
  filters?: Record<string, JsonValue>;
  limit: number;
  offset: number;
  q?: string;
  resource_id: string;
  sort?: string;
}

const datastoreResponseSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
          })
          .passthrough(),
      )
      .default([]),
    records: z.array(z.record(z.unknown())).default([]),
    total: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

export async function queryBcnResource(
  input: BcnQueryResourceInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnQueryResourceResult> {
  const normalized = normalizeQueryInput(input, config);
  const url = buildBcnDatastoreUrl("datastore_search");
  const requestBody = buildDatastoreRequestBody(normalized, true);
  const logicalRequestBody = buildDatastoreRequestBody(normalized, false);
  let raw: unknown;

  try {
    raw = await fetchBcnActionResult(
      {
        method: "POST",
        url,
        body: requestBody,
      },
      config,
      options,
    );
  } catch (error) {
    const inactiveError = await getInactiveDatastoreError(
      error,
      normalized.resource_id,
      config,
      options,
    );

    throw inactiveError ?? error;
  }
  const parsed = datastoreResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN datastore_search response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  const rows = parsed.data.records.map(toJsonRow);
  const hasMoreRows = rows.length > normalized.limit;
  const visibleRows = rows.slice(0, normalized.limit);
  const provenance = createBcnOperationProvenance("datastore_search", url);
  const data = createQueryData({
    fields: parsed.data.fields,
    hasMoreRows,
    normalized,
    requestBody: logicalRequestBody,
    rows: visibleRows,
    total: parsed.data.total ?? null,
    url,
  });

  return {
    data: capResponseData(data, provenance, config.responseMaxBytes),
    provenance,
  };
}

function normalizeQueryInput(
  input: BcnQueryResourceInput,
  config: AppConfig,
): NormalizedQueryInput {
  return {
    resource_id: normalizeBcnId("resource_id", input.resource_id),
    ...(input.filters === undefined ? {} : { filters: normalizeFilters(input.filters) }),
    ...(input.q?.trim() ? { q: input.q.trim() } : {}),
    ...(input.sort?.trim() ? { sort: input.sort.trim() } : {}),
    ...(input.fields && input.fields.length > 0 ? { fields: normalizeFields(input.fields) } : {}),
    limit: normalizeLimit(input.limit, config.maxResults, 100),
    offset: normalizeOffset(input.offset),
  };
}

function normalizeFilters(filters: Record<string, unknown>): Record<string, JsonValue> {
  const normalized = normalizeBcnJsonObject(filters, "filters");
  const byteLength = getUtf8ByteLength(JSON.stringify(normalized));

  if (byteLength > BCN_QUERY_FILTER_TOTAL_MAX_BYTES) {
    throw new BcnError(
      "invalid_input",
      `Open Data BCN filters exceed the ${BCN_QUERY_FILTER_TOTAL_MAX_BYTES}-byte cap.`,
      {
        source_error: {
          rule: "filter_total_bytes",
          observed: byteLength,
          limit: BCN_QUERY_FILTER_TOTAL_MAX_BYTES,
        },
      },
    );
  }

  return normalized;
}

function normalizeFields(fields: string[]): string[] {
  const normalized = fields.map((field) => field.trim()).filter(Boolean);

  if (normalized.length === 0) {
    throw new BcnError("invalid_input", "fields must include at least one non-empty field name.");
  }

  if (normalized.some((field) => field.length > 128 || /[\r\n]/u.test(field))) {
    throw new BcnError("invalid_input", "fields contain an invalid field name.");
  }

  return normalized;
}

function buildDatastoreRequestBody(
  input: NormalizedQueryInput,
  includeSentinelLimit: boolean,
): Record<string, JsonValue> {
  return {
    resource_id: input.resource_id,
    limit: includeSentinelLimit ? input.limit + 1 : input.limit,
    offset: input.offset,
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.fields ? { fields: input.fields } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
  };
}

function createQueryData(input: {
  fields: BcnDatastoreFieldOutput[];
  hasMoreRows: boolean;
  normalized: NormalizedQueryInput;
  requestBody: Record<string, JsonValue>;
  rows: Record<string, JsonValue>[];
  total: number | null;
  url: URL;
}): BcnQueryResourceData {
  const data: BcnQueryResourceData = {
    resource_id: input.normalized.resource_id,
    request_method: "POST",
    request_url: input.url.toString(),
    request_body: input.requestBody,
    ...(input.normalized.filters ? { filters: input.normalized.filters } : {}),
    ...(input.normalized.q ? { q: input.normalized.q } : {}),
    ...(input.normalized.sort ? { sort: input.normalized.sort } : {}),
    limit: input.normalized.limit,
    offset: input.normalized.offset,
    total: input.total,
    fields: input.fields.map((field) => ({ id: field.id, type: field.type })),
    row_count: input.rows.length,
    truncated: input.hasMoreRows,
    rows: input.rows,
  };

  return input.hasMoreRows ? withTruncation(data, "row_cap") : data;
}

function capResponseData(
  data: BcnQueryResourceData,
  provenance: BcnOperationProvenance,
  responseMaxBytes: number,
): BcnQueryResourceData {
  let cappedData = data;

  while (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    if (cappedData.rows.length === 0) {
      throw new BcnError(
        "invalid_response",
        "Open Data BCN query response envelope exceeds response cap even after dropping all rows.",
      );
    }

    const rows = cappedData.rows.slice(0, -1);
    cappedData = withTruncation(
      {
        ...cappedData,
        rows,
        row_count: rows.length,
      },
      "byte_cap",
    );
  }

  return cappedData;
}

function withTruncation(
  data: BcnQueryResourceData,
  reason: BcnQueryTruncationReason,
): BcnQueryResourceData {
  return {
    ...data,
    truncated: true,
    truncation_reason: reason,
    truncation_hint: BCN_QUERY_TRUNCATION_HINTS[reason],
  };
}

function toJsonRow(row: Record<string, unknown>): Record<string, JsonValue> {
  const normalized = normalizeBcnJsonObject(row, "records[]");
  return normalized;
}

async function getInactiveDatastoreError(
  error: unknown,
  resourceId: string,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<BcnError | undefined> {
  if (!isBcnError(error) || error.retryable) {
    return undefined;
  }

  try {
    const metadata = await fetchBcnResourceMetadata(resourceId, config, options, {
      includePackageTitle: false,
    });

    if (!metadata.datastore_active) {
      return new BcnError(
        "invalid_input",
        "Open Data BCN resource is not DataStore-active; use bcn_preview_resource for a bounded download preview.",
        { source_error: error.source_error },
      );
    }
  } catch {
    return undefined;
  }

  return undefined;
}
