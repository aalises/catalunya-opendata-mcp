import { parse as parseCsv } from "csv-parse/sync";

import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength } from "../common/caps.js";
import type { JsonValue } from "../common/json-safe.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeBcnId,
  normalizeLimit,
} from "./catalog.js";
import {
  BCN_DOWNLOAD_HOST,
  BCN_USER_AGENT,
  BcnError,
  type FetchBcnJsonOptions,
  isBcnError,
} from "./client.js";
import { fetchBcnResourceMetadata, normalizeBcnJsonObject } from "./resource.js";

export const BCN_DOWNLOAD_MAX_REDIRECTS = 3;
export const BCN_PREVIEW_TRUNCATION_HINTS = {
  byte_cap: "download preview reached the byte cap; narrow to a DataStore query when available",
  row_cap: "raise limit within maxResults or page through the DataStore when available",
} as const satisfies Record<BcnPreviewTruncationReason, string>;

export interface BcnPreviewResourceInput {
  limit?: number;
  resource_id: string;
}

export type BcnPreviewFormat = "csv" | "json";
export type BcnPreviewTruncationReason = "byte_cap" | "row_cap";

export interface BcnPreviewResourceData {
  charset: string;
  columns: string[];
  delimiter?: "," | ";" | "tab";
  download_url: string;
  format: BcnPreviewFormat;
  limit: number;
  media_type: string | null;
  package_id: string | null;
  request_method: "GET";
  resource_id: string;
  resource_name: string;
  row_count: number;
  rows: Record<string, JsonValue>[];
  truncated: boolean;
  truncation_hint?: string;
  truncation_reason?: BcnPreviewTruncationReason;
}

export interface BcnPreviewResourceResult {
  data: BcnPreviewResourceData;
  provenance: BcnOperationProvenance;
}

export interface BcnDownloadResult {
  bytes: Uint8Array;
  contentType: string | null;
  truncated: boolean;
  url: URL;
}

export interface BcnDecodedText {
  charset: string;
  text: string;
}

export async function previewBcnResource(
  input: BcnPreviewResourceInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnPreviewResourceResult> {
  const normalized = normalizePreviewInput(input, config);
  const metadata = await fetchBcnResourceMetadata(normalized.resource_id, config, options, {
    includePackageTitle: false,
  });

  if (!metadata.url) {
    throw new BcnError("invalid_input", "Open Data BCN resource does not expose a download URL.");
  }

  const download = await fetchBcnDownload(metadata.url, config, options);
  const detectedFormat = detectPreviewFormat({
    contentType: download.contentType,
    format: metadata.format,
    mimetype: metadata.mimetype,
    url: download.url,
  });
  const decoded = decodePreviewBytes(download.bytes, download.contentType);
  const preview =
    detectedFormat === "csv"
      ? createCsvPreview(decoded.text, download.truncated, normalized.limit)
      : createJsonPreview(decoded.text, download.truncated, normalized.limit);
  const provenance = createBcnOperationProvenance("resource_preview", download.url);
  const data = capPreviewData(
    {
      resource_id: normalized.resource_id,
      resource_name: metadata.name,
      package_id: metadata.package_id,
      request_method: "GET",
      download_url: download.url.toString(),
      media_type: getMediaType(download.contentType),
      charset: decoded.charset,
      format: detectedFormat,
      limit: normalized.limit,
      ...preview,
    },
    provenance,
    config.responseMaxBytes,
  );

  return { data, provenance };
}

export function isAllowedBcnDownloadUrl(value: URL): boolean {
  return (
    value.protocol === "https:" &&
    (value.port === "" || value.port === "443") &&
    (value.hostname === BCN_DOWNLOAD_HOST || value.hostname.endsWith(`.${BCN_DOWNLOAD_HOST}`))
  );
}

export async function fetchBcnDownload(
  rawUrl: string,
  config: AppConfig,
  options: FetchBcnJsonOptions,
  maxBytes = config.bcnUpstreamReadBytes,
): Promise<BcnDownloadResult> {
  let url = parseAllowedDownloadUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= BCN_DOWNLOAD_MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchDownloadUrl(url, config, options);

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw new BcnError(
          "invalid_response",
          "Open Data BCN download redirect omitted Location.",
          {
            status: response.status,
          },
        );
      }

      if (redirectCount === BCN_DOWNLOAD_MAX_REDIRECTS) {
        throw new BcnError("invalid_response", "Open Data BCN download exceeded redirect limit.", {
          status: response.status,
        });
      }

      url = parseAllowedDownloadUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new BcnError(
        "http_error",
        `Open Data BCN download failed with HTTP ${response.status} ${response.statusText}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        },
      );
    }

    const body = await readPreviewBodyBytes(response, maxBytes);

    return {
      bytes: body.bytes,
      contentType: response.headers.get("content-type"),
      truncated: body.truncated,
      url,
    };
  }

  throw new BcnError("invalid_response", "Open Data BCN download exceeded redirect limit.");
}

async function fetchDownloadUrl(
  url: URL,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json,text/csv,text/plain,*/*",
        "User-Agent": BCN_USER_AGENT,
      },
      method: "GET",
      redirect: "manual",
      signal: createRequestSignal(config.requestTimeoutMs, options.signal),
    });
  } catch (error) {
    throw toDownloadFetchError(error);
  }
}

function parseAllowedDownloadUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch (error) {
    throw new BcnError("invalid_input", "Open Data BCN resource download URL is invalid.", {
      cause: error,
      source_error: { url: value },
    });
  }

  if (!isAllowedBcnDownloadUrl(url)) {
    throw new BcnError(
      "invalid_input",
      "Open Data BCN preview only fetches HTTPS download URLs hosted by opendata-ajuntament.barcelona.cat.",
      { source_error: { url: url.toString() } },
    );
  }

  return url;
}

async function readPreviewBodyBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const maxBufferedBytes = maxBytes + 1;
  let byteLength = 0;

  try {
    while (byteLength <= maxBytes) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remainingBytes = maxBufferedBytes - byteLength;

      if (value.byteLength > remainingBytes) {
        chunks.push(value.slice(0, remainingBytes));
        byteLength += remainingBytes;
        break;
      }

      chunks.push(value);
      byteLength += value.byteLength;
    }

    const truncated = byteLength > maxBytes;

    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }

    return {
      bytes: concatChunks(chunks, truncated ? maxBytes : byteLength),
      truncated,
    };
  } catch (error) {
    if (isBcnError(error)) {
      throw error;
    }

    throw new BcnError("invalid_response", "Open Data BCN download body could not be read.", {
      cause: error,
    });
  }
}

export function detectPreviewFormat(input: {
  contentType: string | null;
  format: string | null;
  mimetype: string | null;
  url: URL;
}): BcnPreviewFormat {
  const signals = [input.contentType, input.format, input.mimetype, input.url.pathname]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  if (signals.some((value) => value.includes("json") || value.endsWith(".json"))) {
    return "json";
  }

  if (
    signals.some(
      (value) =>
        value.includes("csv") ||
        value.includes("semicolon-separated") ||
        value.endsWith(".csv") ||
        value.endsWith(".txt"),
    )
  ) {
    return "csv";
  }

  throw new BcnError(
    "invalid_input",
    "Open Data BCN preview supports CSV and JSON resources only.",
    {
      source_error: {
        content_type: input.contentType,
        format: input.format,
        mimetype: input.mimetype,
        path: input.url.pathname,
      },
    },
  );
}

export function decodePreviewBytes(bytes: Uint8Array, contentType: string | null): BcnDecodedText {
  const declaredCharset = getCharset(contentType);

  if (declaredCharset) {
    const decoded = decodeWithCharset(bytes, declaredCharset);

    if (decoded) {
      return decoded;
    }
  }

  const utf8 = decodeWithCharset(bytes, "utf-8");

  if (utf8) {
    return utf8;
  }

  return (
    decodeWithCharset(bytes, "windows-1252", false) ?? {
      charset: "windows-1252",
      text: new TextDecoder("windows-1252").decode(bytes),
    }
  );
}

function decodeWithCharset(
  bytes: Uint8Array,
  charset: string,
  fatal = true,
): BcnDecodedText | undefined {
  try {
    return {
      charset: charset.toLowerCase(),
      text: stripByteOrderMark(new TextDecoder(charset, { fatal }).decode(bytes)),
    };
  } catch {
    return undefined;
  }
}

function createCsvPreview(
  text: string,
  byteTruncated: boolean,
  limit: number,
): Pick<
  BcnPreviewResourceData,
  | "columns"
  | "delimiter"
  | "row_count"
  | "rows"
  | "truncated"
  | "truncation_hint"
  | "truncation_reason"
> {
  const parseText = byteTruncated ? trimToLastCompleteLine(text) : text;
  const delimiter = detectCsvDelimiter(parseText);
  const outputDelimiter: "," | ";" | "tab" = delimiter === "\t" ? "tab" : delimiter;
  const rows = parseCsvRows(parseText, delimiter);
  const hasMoreRows = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const data = {
    columns: getCsvColumns(parseText, delimiter),
    delimiter: outputDelimiter,
    row_count: visibleRows.length,
    rows: visibleRows,
    truncated: byteTruncated || hasMoreRows,
  };

  if (!byteTruncated && !hasMoreRows) {
    return data;
  }

  return withPreviewTruncation(data, byteTruncated ? "byte_cap" : "row_cap");
}

function createJsonPreview(
  text: string,
  byteTruncated: boolean,
  limit: number,
): Pick<
  BcnPreviewResourceData,
  "columns" | "row_count" | "rows" | "truncated" | "truncation_hint" | "truncation_reason"
> {
  if (byteTruncated) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN JSON preview reached the byte cap before a complete JSON document could be read.",
      {
        source_error: {
          rule: "download_byte_cap",
        },
      },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BcnError("invalid_response", "Open Data BCN JSON preview could not be parsed.", {
      cause: error,
    });
  }

  const rows = toJsonPreviewRows(parsed);
  const hasMoreRows = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const data = {
    columns: getColumns(visibleRows),
    row_count: visibleRows.length,
    rows: visibleRows,
    truncated: hasMoreRows,
  };

  return hasMoreRows ? withPreviewTruncation(data, "row_cap") : data;
}

export function parseCsvRows(
  text: string,
  delimiter: "," | ";" | "\t",
): Record<string, JsonValue>[] {
  try {
    const parsed = parseCsv(text, {
      bom: true,
      columns: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as Array<Record<string, unknown>>;

    return parsed.map((row) => normalizePreviewRow(row, "csv records[]"));
  } catch (error) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN CSV preview could not be parsed; try DataStore querying if this resource is DataStore-active.",
      { cause: error },
    );
  }
}

function getCsvColumns(text: string, delimiter: "," | ";" | "\t"): string[] {
  try {
    const parsed = parseCsv(text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      to_line: 1,
    }) as string[][];

    return (parsed[0] ?? []).map((column) => String(column));
  } catch {
    return getColumns(parseCsvRows(text, delimiter));
  }
}

export function detectCsvDelimiter(text: string): "," | ";" | "\t" {
  const headerLine = text
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.replace(/^\uFEFF/u, "");
  const candidates = [",", ";", "\t"] as const;

  if (!headerLine) {
    throw new BcnError("invalid_response", "Open Data BCN CSV preview has no header row.");
  }

  return candidates.reduce((best, candidate) =>
    countOccurrences(headerLine, candidate) > countOccurrences(headerLine, best) ? candidate : best,
  );
}

export function trimToLastCompleteLine(text: string): string {
  const newlineIndex = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));

  if (newlineIndex < 0) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN preview byte cap was reached before a complete CSV row could be read.",
      {
        source_error: {
          rule: "download_byte_cap",
        },
      },
    );
  }

  return text.slice(0, newlineIndex + 1);
}

function toJsonPreviewRows(value: unknown): Record<string, JsonValue>[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePreviewRow(item, "json records[]"));
  }

  return [normalizePreviewRow(value, "json document")];
}

function normalizePreviewRow(value: unknown, name: string): Record<string, JsonValue> {
  try {
    return normalizeBcnJsonObject(value, name);
  } catch (error) {
    if (isBcnError(error) && error.code === "invalid_input") {
      throw new BcnError(
        "invalid_response",
        `Open Data BCN preview ${name} must be a JSON object.`,
        { cause: error },
      );
    }

    throw error;
  }
}

function capPreviewData(
  data: BcnPreviewResourceData,
  provenance: BcnOperationProvenance,
  responseMaxBytes: number,
): BcnPreviewResourceData {
  let cappedData = data;

  while (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    if (cappedData.rows.length === 0) {
      throw new BcnError(
        "invalid_response",
        "Open Data BCN preview response envelope exceeds response cap even after dropping all rows.",
      );
    }

    const rows = cappedData.rows.slice(0, -1);
    cappedData = withPreviewTruncation(
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

function withPreviewTruncation<T extends { truncated: boolean }>(
  data: T,
  reason: BcnPreviewTruncationReason,
): T & {
  truncation_hint: string;
  truncation_reason: BcnPreviewTruncationReason;
} {
  return {
    ...data,
    truncated: true,
    truncation_reason: reason,
    truncation_hint: BCN_PREVIEW_TRUNCATION_HINTS[reason],
  };
}

function normalizePreviewInput(
  input: BcnPreviewResourceInput,
  config: AppConfig,
): { limit: number; resource_id: string } {
  return {
    resource_id: normalizeBcnId("resource_id", input.resource_id),
    limit: normalizeLimit(input.limit, config.maxResults, 20),
  };
}

function getColumns(rows: Record<string, JsonValue>[]): string[] {
  const columns = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }

  return [...columns];
}

function getCharset(contentType: string | null): string | undefined {
  const match = contentType?.match(/charset\s*=\s*"?([^";]+)"?/iu);
  return match?.[1]?.trim();
}

function getMediaType(contentType: string | null): string | null {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType || null;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function stripByteOrderMark(value: string): string {
  return value.replace(/^\uFEFF/u, "");
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    const remaining = byteLength - offset;

    if (remaining <= 0) {
      break;
    }

    const slice = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
    bodyBytes.set(slice, offset);
    offset += slice.byteLength;
  }

  return bodyBytes;
}

function createRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function toDownloadFetchError(error: unknown): BcnError {
  const name = getErrorName(error);

  if (name === "TimeoutError" || name === "AbortError") {
    return new BcnError("timeout", "Open Data BCN download request timed out.", {
      cause: error,
      retryable: true,
    });
  }

  return new BcnError("network_error", "Open Data BCN download request failed.", {
    cause: error,
    retryable: true,
  });
}

function getErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return undefined;
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}
