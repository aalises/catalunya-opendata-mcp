import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import { packageVersion } from "../../package-info.js";
import { SourceError, type SourceErrorCode } from "../common/errors.js";
import { toJsonSafeValue } from "../common/json-safe.js";

export const BCN_ACTION_BASE_URL = "https://opendata-ajuntament.barcelona.cat/data/api/3/action";
export const BCN_DATASTORE_BASE_URL = "https://opendata-ajuntament.barcelona.cat/data/api/action";
export const BCN_DOWNLOAD_HOST = "opendata-ajuntament.barcelona.cat";
export const BCN_ERROR_BODY_MAX_BYTES = 4_096;
export const BCN_ERROR_BODY_MAX_CHARS = 2_000;
export const BCN_SUCCESS_BODY_MAX_BYTES = 1_048_576;
export const BCN_USER_AGENT = `catalunya-opendata-mcp/${packageVersion}`;

export type BcnErrorCode = Extract<
  SourceErrorCode,
  "http_error" | "invalid_input" | "invalid_response" | "network_error" | "timeout"
>;

export class BcnError extends SourceError<"bcn"> {
  constructor(
    code: BcnErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      source_error?: unknown;
      status?: number;
    } = {},
  ) {
    super("bcn", code, message, options);
    this.name = "BcnError";
  }
}

export interface BcnHttpRequest {
  body?: unknown;
  method?: "GET" | "POST";
  url: URL;
}

export interface FetchBcnJsonOptions {
  logger?: Logger;
  signal?: AbortSignal;
  successBodyMaxBytes?: number;
}

export function isBcnError(error: unknown): error is BcnError {
  return error instanceof BcnError;
}

export function buildBcnActionUrl(action: string, params: Record<string, string> = {}): URL {
  return buildBcnApiUrl(BCN_ACTION_BASE_URL, action, params);
}

export function buildBcnDatastoreUrl(action: string, params: Record<string, string> = {}): URL {
  return buildBcnApiUrl(BCN_DATASTORE_BASE_URL, action, params);
}

export async function fetchBcnActionResult(
  request: BcnHttpRequest,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<unknown> {
  const raw = await fetchBcnJson(request, config, options);

  if (!isRecord(raw) || typeof raw.success !== "boolean") {
    throw new BcnError("invalid_response", "Open Data BCN returned an invalid CKAN envelope.");
  }

  if (!raw.success) {
    throw new BcnError("http_error", getCkanErrorMessage(raw.error), {
      retryable: isCkanRetryableError(raw.error),
      source_error: toJsonSafeValue(raw.error),
    });
  }

  return raw.result;
}

export async function fetchBcnJson(
  request: BcnHttpRequest,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<unknown> {
  const logger = options.logger ?? createLogger(config).child({ source: "bcn" });
  const startedAt = performance.now();
  let response: Response;

  try {
    response = await fetchBcnUrl(request, config, options);
  } catch (error) {
    logBcnFetchFailure(logger, request.url, startedAt, error);
    throw error;
  }

  if (!response.ok) {
    const error = await createHttpError(response);
    logger.warn("upstream_request", {
      url: request.url.toString(),
      status: response.status,
      durationMs: getDurationMs(startedAt),
      code: error.code,
      retryable: error.retryable,
    });
    throw error;
  }

  const bodyText = await readBodyText(
    response,
    options.successBodyMaxBytes ?? getBcnSuccessBodyMaxBytes(config),
    "throw",
  ).catch((error: unknown) => {
    logBcnFetchFailure(logger, request.url, startedAt, error);
    throw error;
  });

  try {
    const parsed = JSON.parse(bodyText);

    logger.debug("upstream_request", {
      url: request.url.toString(),
      status: response.status,
      durationMs: getDurationMs(startedAt),
      retryable: false,
    });

    return parsed;
  } catch (error) {
    const bcnError = new BcnError("invalid_response", "Open Data BCN returned invalid JSON.", {
      cause: error,
    });
    logBcnFetchFailure(logger, request.url, startedAt, bcnError);
    throw bcnError;
  }
}

function buildBcnApiUrl(baseUrl: string, action: string, params: Record<string, string> = {}): URL {
  if (!/^[a-z_]+$/u.test(action)) {
    throw new BcnError("invalid_input", `Invalid Open Data BCN action ${JSON.stringify(action)}.`);
  }

  const url = new URL(`${baseUrl}/${action}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

async function fetchBcnUrl(
  request: BcnHttpRequest,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<Response> {
  try {
    return await fetch(request.url, {
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers: buildHeaders(request),
      method: request.method ?? "GET",
      signal: createRequestSignal(config.requestTimeoutMs, options.signal),
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

function buildHeaders(request: BcnHttpRequest): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": BCN_USER_AGENT,
  };

  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function createHttpError(response: Response): Promise<BcnError> {
  const details = await readErrorBodyDetails(response);
  const bodyMessage = details.excerpt ? ` Response body: ${details.excerpt}` : "";

  return new BcnError(
    "http_error",
    `Open Data BCN request failed with HTTP ${response.status} ${response.statusText}.${bodyMessage}`,
    {
      retryable: response.status === 429 || response.status >= 500,
      source_error:
        details.json ??
        (details.excerpt ? { kind: "text_excerpt", excerpt: details.excerpt } : undefined),
      status: response.status,
    },
  );
}

interface ErrorBodyDetails {
  excerpt: string | null;
  json?: unknown;
}

async function readErrorBodyDetails(response: Response): Promise<ErrorBodyDetails> {
  if (!response.body) {
    return { excerpt: null };
  }

  try {
    const text = await readBodyText(response, BCN_ERROR_BODY_MAX_BYTES, "truncate");
    const collapsed = text.replace(/\s+/g, " ").trim();
    const json = parseJsonSafely(text);

    if (!collapsed) {
      return { excerpt: null, ...(json === undefined ? {} : { json }) };
    }

    return {
      excerpt:
        collapsed.length > BCN_ERROR_BODY_MAX_CHARS
          ? `${collapsed.slice(0, BCN_ERROR_BODY_MAX_CHARS)}...`
          : collapsed,
      ...(json === undefined ? {} : { json }),
    };
  } catch {
    return { excerpt: null };
  }
}

async function readBodyText(
  response: Response,
  maxBytes: number,
  onOverflow: "throw" | "truncate",
): Promise<string> {
  const bytes = await readBodyBytes(response, maxBytes, onOverflow);
  return new TextDecoder().decode(bytes);
}

async function readBodyBytes(
  response: Response,
  maxBytes: number,
  onOverflow: "throw" | "truncate",
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
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

    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);

      if (onOverflow === "throw") {
        throw new BcnError(
          "invalid_response",
          `Open Data BCN response body exceeded maximum size of ${maxBytes} bytes.`,
        );
      }

      return concatChunks(chunks, maxBytes);
    }

    return concatChunks(chunks, byteLength);
  } catch (error) {
    if (isBcnError(error)) {
      throw error;
    }

    throw new BcnError("invalid_response", "Open Data BCN response body could not be read.", {
      cause: error,
    });
  }
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

function getCkanErrorMessage(error: unknown): string {
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : undefined;
    const type = typeof error.__type === "string" ? error.__type : undefined;

    if (message && type) {
      return `Open Data BCN CKAN error (${type}): ${message}`;
    }

    if (message) {
      return `Open Data BCN CKAN error: ${message}`;
    }
  }

  return "Open Data BCN CKAN action failed.";
}

function isCkanRetryableError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const status = getNumericStatus(error);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }

  const searchable = [error.__type, error.type, error.message, error.error]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return /operational|timeout|temporar|too many|rate limit|service unavailable|internal server|bad gateway|gateway timeout/u.test(
    searchable,
  );
}

function getNumericStatus(error: Record<string, unknown>): number | undefined {
  for (const key of ["status", "status_code", "code"]) {
    const value = error[key];

    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === "string" && /^\d{3}$/u.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

function getBcnSuccessBodyMaxBytes(config: AppConfig): number {
  return Math.max(config.responseMaxBytes, config.bcnUpstreamReadBytes, BCN_SUCCESS_BODY_MAX_BYTES);
}

function parseJsonSafely(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function createRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([signal, timeoutSignal]);
}

function toFetchError(error: unknown): BcnError {
  const name = getErrorName(error);

  if (name === "TimeoutError" || name === "AbortError") {
    return new BcnError("timeout", "Open Data BCN request timed out.", {
      cause: error,
      retryable: true,
    });
  }

  return new BcnError("network_error", "Open Data BCN request failed.", {
    cause: error,
    retryable: true,
  });
}

function logBcnFetchFailure(logger: Logger, url: URL, startedAt: number, error: unknown): void {
  const isBcn = error instanceof BcnError;

  logger.warn("upstream_request", {
    url: url.toString(),
    status: isBcn ? error.status : undefined,
    durationMs: getDurationMs(startedAt),
    code: isBcn ? error.code : "unknown",
    retryable: isBcn ? error.retryable : undefined,
    error,
  });
}

function getDurationMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function getErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return undefined;
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
