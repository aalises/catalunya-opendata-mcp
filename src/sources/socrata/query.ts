import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { SocrataOperationProvenance } from "./catalog.js";
import {
  type FetchSocrataJsonOptions,
  fetchSocrataJson,
  normalizeSourceId,
  SOCRATA_CATALOG_DOMAIN,
  SocrataError,
} from "./client.js";

export const SOCRATA_QUERY_CLAUSE_MAX_BYTES = 4_096;
export const SOCRATA_QUERY_TRUNCATION_HINTS = {
  byte_cap: "narrow filters or reduce $select",
  row_cap: "raise limit (within maxResults) or paginate with $offset",
} as const satisfies Record<SocrataQueryTruncationReason, string>;
export const SOCRATA_QUERY_URL_MAX_BYTES = 8_192;

const socrataQueryRowsResponseSchema = z.array(
  z.custom<Record<string, unknown>>((value) => isRecord(value), {
    message: "Expected row object.",
  }),
);

export type SocrataQueryRow = Record<string, unknown>;

export interface SocrataQueryDatasetInput {
  source_id: string;
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export type SocrataQueryTruncationReason = "byte_cap" | "row_cap";

export interface SocrataQueryDatasetData {
  source_id: string;
  source_domain: string;
  api_endpoint: string;
  request_url: string;
  logical_request_url: string;
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit: number;
  offset: number;
  row_count: number;
  truncated: boolean;
  truncation_reason?: SocrataQueryTruncationReason;
  truncation_hint?: string;
  rows: SocrataQueryRow[];
}

export interface SocrataQueryDatasetResult {
  data: SocrataQueryDatasetData;
  provenance: SocrataOperationProvenance;
}

interface NormalizedSocrataQueryDatasetInput {
  source_id: string;
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit: number;
  offset: number;
}

export async function querySocrataDataset(
  input: SocrataQueryDatasetInput,
  config: AppConfig,
  options: FetchSocrataJsonOptions = {},
): Promise<SocrataQueryDatasetResult> {
  const normalizedInput = normalizeQueryInput(input, config);
  const requestUrl = buildSocrataDatasetQueryUrl(normalizedInput, {
    includeSentinelLimit: true,
  });
  validateUrlByteLength(requestUrl);

  const rawRows = await fetchSocrataJson(requestUrl, config, options);
  const parsed = socrataQueryRowsResponseSchema.safeParse(rawRows);

  if (!parsed.success) {
    throw new SocrataError(
      "invalid_response",
      `Invalid Socrata query response: ${formatZodError(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }

  // logicalRequestUrl differs from requestUrl only in the digit-length of $limit
  // (limit vs limit + 1), so it is always <= requestUrl in bytes. The earlier
  // validateUrlByteLength(requestUrl) covers this URL too.
  const logicalRequestUrl = buildSocrataDatasetQueryUrl(normalizedInput);

  const returnedRows = parsed.data as SocrataQueryRow[];
  const hasMoreRows = returnedRows.length > normalizedInput.limit;
  const visibleRows = returnedRows.slice(0, normalizedInput.limit);
  const provenance = createSocrataQueryProvenance(input, config, requestUrl);
  const data = createQueryData({
    hasMoreRows,
    logicalRequestUrl,
    normalizedInput,
    requestUrl,
    rows: visibleRows,
  });

  return {
    data: capResponseData(data, provenance, config.responseMaxBytes),
    provenance,
  };
}

export function createSocrataQueryProvenance(
  input: SocrataQueryDatasetInput,
  config: AppConfig,
  requestUrl?: URL,
): SocrataOperationProvenance {
  let resolvedUrl = requestUrl;

  if (!resolvedUrl) {
    try {
      const normalizedInput = normalizeQueryInput(input, config);
      resolvedUrl = buildSocrataDatasetQueryUrl(normalizedInput, {
        includeSentinelLimit: true,
      });
      validateUrlByteLength(resolvedUrl);
    } catch {
      resolvedUrl = new URL(`https://${SOCRATA_CATALOG_DOMAIN}/`);
    }
  }

  return {
    source: "socrata",
    source_url: resolvedUrl.toString(),
    id: `${SOCRATA_CATALOG_DOMAIN}:dataset_query`,
    last_updated: null,
    license_or_terms: null,
    language: "ca",
  };
}

export function buildSocrataDatasetQueryUrl(
  input: NormalizedSocrataQueryDatasetInput,
  options: { includeSentinelLimit?: boolean } = {},
): URL {
  const url = new URL(`https://${SOCRATA_CATALOG_DOMAIN}/resource/${input.source_id}.json`);

  setOptionalParam(url, "$select", input.select);
  setOptionalParam(url, "$where", input.where);
  setOptionalParam(url, "$group", input.group);
  setOptionalParam(url, "$order", input.order);
  url.searchParams.set(
    "$limit",
    String(options.includeSentinelLimit ? input.limit + 1 : input.limit),
  );
  url.searchParams.set("$offset", String(input.offset));

  return url;
}

function normalizeQueryInput(
  input: SocrataQueryDatasetInput,
  config: AppConfig,
): NormalizedSocrataQueryDatasetInput {
  return {
    source_id: normalizeSourceId(input.source_id),
    ...normalizeClauseFields(input),
    limit: normalizeLimit(input.limit, config.maxResults),
    offset: normalizeOffset(input.offset),
  };
}

function normalizeClauseFields(
  input: SocrataQueryDatasetInput,
): Pick<NormalizedSocrataQueryDatasetInput, "group" | "order" | "select" | "where"> {
  return {
    ...normalizeClause("select", input.select),
    ...normalizeClause("where", input.where),
    ...normalizeClause("group", input.group),
    ...normalizeClause("order", input.order),
  };
}

function normalizeClause(
  name: "group" | "order" | "select" | "where",
  value: string | undefined,
): Partial<Pick<NormalizedSocrataQueryDatasetInput, typeof name>> {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return {};
  }

  const byteLength = Buffer.byteLength(trimmedValue, "utf8");

  if (byteLength > SOCRATA_QUERY_CLAUSE_MAX_BYTES) {
    throw new SocrataError(
      "invalid_input",
      `${name} exceeds the ${SOCRATA_QUERY_CLAUSE_MAX_BYTES}-byte SODA clause cap.`,
    );
  }

  return {
    [name]: trimmedValue,
  } as Partial<Pick<NormalizedSocrataQueryDatasetInput, typeof name>>;
}

function normalizeLimit(limit: number | undefined, maxResults: number): number {
  const normalizedLimit = limit ?? Math.min(100, maxResults);

  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new SocrataError(
      "invalid_input",
      "limit must be a safe integer greater than or equal to 1.",
    );
  }

  if (normalizedLimit > maxResults) {
    throw new SocrataError(
      "invalid_input",
      `limit ${normalizedLimit} exceeds the configured maximum of ${maxResults}.`,
    );
  }

  return normalizedLimit;
}

function normalizeOffset(offset: number | undefined): number {
  const normalizedOffset = offset ?? 0;

  if (!Number.isSafeInteger(normalizedOffset) || normalizedOffset < 0) {
    throw new SocrataError("invalid_input", "offset must be a non-negative safe integer.");
  }

  return normalizedOffset;
}

function validateUrlByteLength(url: URL): void {
  const byteLength = Buffer.byteLength(url.toString(), "utf8");

  if (byteLength > SOCRATA_QUERY_URL_MAX_BYTES) {
    throw new SocrataError(
      "invalid_input",
      `Socrata query URL exceeds the ${SOCRATA_QUERY_URL_MAX_BYTES}-byte cap.`,
    );
  }
}

function setOptionalParam(url: URL, name: string, value: string | undefined): void {
  if (value) {
    url.searchParams.set(name, value);
  }
}

function createQueryData(input: {
  hasMoreRows: boolean;
  logicalRequestUrl: URL;
  normalizedInput: NormalizedSocrataQueryDatasetInput;
  requestUrl: URL;
  rows: SocrataQueryRow[];
}): SocrataQueryDatasetData {
  const { hasMoreRows, logicalRequestUrl, normalizedInput, requestUrl, rows } = input;
  const data: SocrataQueryDatasetData = {
    source_id: normalizedInput.source_id,
    source_domain: SOCRATA_CATALOG_DOMAIN,
    api_endpoint: `https://${SOCRATA_CATALOG_DOMAIN}/resource/${normalizedInput.source_id}.json`,
    request_url: requestUrl.toString(),
    logical_request_url: logicalRequestUrl.toString(),
    ...getClauseOutput(normalizedInput),
    limit: normalizedInput.limit,
    offset: normalizedInput.offset,
    row_count: rows.length,
    truncated: hasMoreRows,
    rows,
  };

  if (hasMoreRows) {
    return withTruncation(data, "row_cap");
  }

  return data;
}

function getClauseOutput(
  input: NormalizedSocrataQueryDatasetInput,
): Pick<SocrataQueryDatasetData, "group" | "order" | "select" | "where"> {
  return {
    ...(input.select ? { select: input.select } : {}),
    ...(input.where ? { where: input.where } : {}),
    ...(input.group ? { group: input.group } : {}),
    ...(input.order ? { order: input.order } : {}),
  };
}

function withTruncation(
  data: SocrataQueryDatasetData,
  reason: SocrataQueryTruncationReason,
): SocrataQueryDatasetData {
  return {
    ...data,
    truncated: true,
    truncation_reason: reason,
    truncation_hint: SOCRATA_QUERY_TRUNCATION_HINTS[reason],
  };
}

// Precedence: byte_cap > row_cap. If createQueryData already stamped row_cap from
// the sentinel, dropping further rows here intentionally overwrites the reason
// to byte_cap because raising limit would not help the caller — narrowing or
// $select reduction would.
function capResponseData(
  data: SocrataQueryDatasetData,
  provenance: SocrataOperationProvenance,
  responseMaxBytes: number,
): SocrataQueryDatasetData {
  let cappedData = data;

  while (getEnvelopeByteLength(cappedData, provenance) > responseMaxBytes) {
    if (cappedData.rows.length === 0) {
      throw new SocrataError(
        "invalid_response",
        "Socrata response envelope exceeds response cap even after dropping all rows.",
      );
    }

    const rows = cappedData.rows.slice(0, -1);
    cappedData = withTruncation(
      {
        ...cappedData,
        row_count: rows.length,
        rows,
      },
      "byte_cap",
    );
  }

  return cappedData;
}

function getEnvelopeByteLength(
  data: SocrataQueryDatasetData,
  provenance: SocrataOperationProvenance,
): number {
  return Buffer.byteLength(JSON.stringify({ data, provenance }), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
}
