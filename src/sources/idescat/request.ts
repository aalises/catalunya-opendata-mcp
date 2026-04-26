import { getUrlByteLength, getUtf8ByteLength } from "../common/caps.js";
import {
  IDESCAT_TABLES_BASE_URL,
  IdescatError,
  type IdescatHttpRequest,
  type IdescatLanguage,
} from "./client.js";

export const IDESCAT_FILTER_COUNT_MAX = 32;
export const IDESCAT_FILTER_KEY_MAX_BYTES = 64;
export const IDESCAT_FILTER_TOTAL_MAX_BYTES = 4_096;
export const IDESCAT_FILTER_VALUE_MAX_BYTES = 256;
export const IDESCAT_LOGICAL_URL_MAX_BYTES = 8_192;
export const IDESCAT_POST_BODY_MAX_BYTES = 16_384;
export const IDESCAT_POST_THRESHOLD_BYTES = 2_000;

export type IdescatFilterValue = string | string[];
export type NormalizedIdescatFilters = Record<string, IdescatFilterValue>;

export interface IdescatPathTuple {
  geo_id?: string;
  node_id?: string;
  statistics_id?: string;
  table_id?: string;
}

export interface BuildIdescatUrlInput extends IdescatPathTuple {
  data?: boolean;
  lang: IdescatLanguage;
}

export interface BuildIdescatDataRequestInput extends Required<IdescatPathTuple> {
  filters?: Record<string, unknown>;
  lang: IdescatLanguage;
  last?: number;
}

interface NormalizedFilterResult {
  filters: NormalizedIdescatFilters;
  totalBytes: number;
}

export interface BuiltIdescatDataRequest {
  filters?: NormalizedIdescatFilters;
  last?: number;
  logicalRequestUrl: URL;
  request: IdescatHttpRequest;
  requestBodyParams?: Record<string, string>;
  requestMethod: "GET" | "POST";
}

export function buildIdescatUrl(input: BuildIdescatUrlInput): URL {
  const segments = [
    input.statistics_id === undefined
      ? undefined
      : safePathSegment("statistics_id", input.statistics_id),
    input.node_id === undefined ? undefined : safePathSegment("node_id", input.node_id),
    input.table_id === undefined ? undefined : safePathSegment("table_id", input.table_id),
    input.geo_id === undefined ? undefined : safePathSegment("geo_id", input.geo_id),
  ].filter((segment): segment is string => segment !== undefined);
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const url = new URL(path ? `${IDESCAT_TABLES_BASE_URL}/${path}` : IDESCAT_TABLES_BASE_URL);

  if (input.data) {
    url.pathname = `${url.pathname}/data`;
  }

  url.searchParams.set("lang", input.lang);
  return url;
}

export function buildIdescatDataRequest(
  input: BuildIdescatDataRequestInput,
): BuiltIdescatDataRequest {
  const last = normalizeLast(input.last);
  const normalizedFilters = normalizeFilters(input.filters);
  const filters = normalizedFilters.filters;
  const logicalRequestUrl = buildIdescatUrl({ ...input, data: true });
  const bodyParams = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    const joinedValue = Array.isArray(value) ? value.join(",") : value;
    logicalRequestUrl.searchParams.set(key, joinedValue);
    bodyParams.set(key, joinedValue);
  }

  if (last !== undefined) {
    logicalRequestUrl.searchParams.set("_LAST_", String(last));
  }

  if (getUrlByteLength(logicalRequestUrl) <= IDESCAT_POST_THRESHOLD_BYTES) {
    validateFilterTotalLength(normalizedFilters.totalBytes);
    validateUrlLength(logicalRequestUrl);

    return {
      filters: emptyRecordAsUndefined(filters),
      last,
      logicalRequestUrl,
      request: {
        method: "GET",
        url: logicalRequestUrl,
      },
      requestMethod: "GET",
    };
  }

  const requestUrl = buildIdescatUrl({ ...input, data: true });

  if (last !== undefined) {
    requestUrl.searchParams.set("_LAST_", String(last));
  }

  const requestBodyParams = Object.fromEntries(bodyParams.entries());
  // Validate POST body before filter_total/url so post_body_bytes is reachable —
  // an earlier revision deliberately put it last to keep the cap unreachable; do
  // not flip the order back without re-reading the cap-error tests.
  validatePostBodyLength(bodyParams);
  validateFilterTotalLength(normalizedFilters.totalBytes);
  validateUrlLength(logicalRequestUrl);

  return {
    filters: emptyRecordAsUndefined(filters),
    last,
    logicalRequestUrl,
    request: {
      body: bodyParams,
      method: "POST",
      url: requestUrl,
    },
    requestBodyParams,
    requestMethod: "POST",
  };
}

export function safePathSegment(name: string, value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    hasWhitespaceOrControl(value) ||
    value.includes("/") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("..")
  ) {
    throw new IdescatError("invalid_input", `${name} is not a safe IDESCAT path segment.`);
  }

  return value;
}

export function normalizeLimit(
  limit: number | undefined,
  maxResults: number,
  fallback: number,
): number {
  const normalizedLimit = limit ?? Math.min(fallback, maxResults);

  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new IdescatError(
      "invalid_input",
      "limit must be a safe integer greater than or equal to 1.",
    );
  }

  if (normalizedLimit > maxResults) {
    throw new IdescatError(
      "invalid_input",
      `limit ${normalizedLimit} exceeds the configured maximum of ${maxResults}.`,
    );
  }

  return normalizedLimit;
}

export function normalizeOffset(offset: number | undefined): number {
  const normalizedOffset = offset ?? 0;

  if (!Number.isSafeInteger(normalizedOffset) || normalizedOffset < 0) {
    throw new IdescatError("invalid_input", "offset must be a non-negative safe integer.");
  }

  return normalizedOffset;
}

function normalizeLast(last: number | undefined): number | undefined {
  if (last === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(last) || last < 1) {
    throw new IdescatError(
      "invalid_input",
      "last must be a safe integer greater than or equal to 1.",
    );
  }

  return last;
}

function normalizeFilters(filters: Record<string, unknown> | undefined): NormalizedFilterResult {
  if (filters === undefined) {
    return {
      filters: {},
      totalBytes: 0,
    };
  }

  if (!isPlainRecord(filters)) {
    throw new IdescatError("invalid_input", "filters must be an object.");
  }

  // Plan-mandated Unicode code-point ordering — localeCompare is locale-sensitive
  // and would produce different canonical forms across runtimes / locales,
  // breaking the equal-intent → equal-URL guarantee.
  const entries = Object.entries(filters).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  if (entries.length > IDESCAT_FILTER_COUNT_MAX) {
    throwFilterCapError("filter_count", entries.length, IDESCAT_FILTER_COUNT_MAX);
  }

  const normalized: NormalizedIdescatFilters = {};
  let totalBytes = 0;

  for (const [key, value] of entries) {
    validateFilterKey(key);
    totalBytes += getUtf8ByteLength(key);

    const values = Array.isArray(value) ? value : [value];

    if (values.length === 0) {
      throw new IdescatError("invalid_input", `filter ${key} must not be an empty array.`);
    }

    const normalizedValues = values.map((item) => normalizeFilterValue(key, item));

    for (const item of normalizedValues) {
      totalBytes += getUtf8ByteLength(item);
    }

    normalized[key] = Array.isArray(value) ? normalizedValues : (normalizedValues[0] ?? "");
  }

  return {
    filters: normalized,
    totalBytes,
  };
}

function validateFilterKey(key: string): void {
  if (key === "lang" || key === "_LAST_") {
    throw new IdescatError("invalid_input", `filter ${key} is reserved.`);
  }

  if (key.length === 0 || key !== key.trim() || key.includes(",") || hasWhitespaceOrControl(key)) {
    throw new IdescatError("invalid_input", `filter key ${JSON.stringify(key)} is invalid.`);
  }

  const byteLength = getUtf8ByteLength(key);

  if (byteLength > IDESCAT_FILTER_KEY_MAX_BYTES) {
    throwFilterCapError("filter_key_bytes", byteLength, IDESCAT_FILTER_KEY_MAX_BYTES);
  }
}

function normalizeFilterValue(key: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new IdescatError("invalid_input", `filter ${key} values must be non-empty strings.`);
  }

  if (value.includes(",") || hasControlCharacter(value)) {
    throw new IdescatError(
      "invalid_input",
      `filter ${key} value ${JSON.stringify(value)} is invalid.`,
    );
  }

  const byteLength = getUtf8ByteLength(value);

  if (byteLength > IDESCAT_FILTER_VALUE_MAX_BYTES) {
    throwFilterCapError("filter_value_bytes", byteLength, IDESCAT_FILTER_VALUE_MAX_BYTES);
  }

  return value;
}

function validateUrlLength(url: URL): void {
  const byteLength = getUrlByteLength(url);

  if (byteLength > IDESCAT_LOGICAL_URL_MAX_BYTES) {
    throwFilterCapError("logical_url_bytes", byteLength, IDESCAT_LOGICAL_URL_MAX_BYTES);
  }
}

function validateFilterTotalLength(byteLength: number): void {
  if (byteLength > IDESCAT_FILTER_TOTAL_MAX_BYTES) {
    throwFilterCapError("filter_total_bytes", byteLength, IDESCAT_FILTER_TOTAL_MAX_BYTES);
  }
}

function validatePostBodyLength(body: URLSearchParams): void {
  const byteLength = getUtf8ByteLength(body.toString());

  if (byteLength > IDESCAT_POST_BODY_MAX_BYTES) {
    throwFilterCapError("post_body_bytes", byteLength, IDESCAT_POST_BODY_MAX_BYTES);
  }
}

function throwFilterCapError(rule: string, observed: number, limit: number): never {
  throw new IdescatError("invalid_input", `IDESCAT filter cap exceeded: ${rule}.`, {
    source_error: {
      rule,
      observed,
      limit,
    },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function emptyRecordAsUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

function hasWhitespaceOrControl(value: string): boolean {
  for (const char of value) {
    if (char.trim() === "" || isControlCharacter(char)) {
      return true;
    }
  }

  return false;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlCharacter(char)) {
      return true;
    }
  }

  return false;
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}
