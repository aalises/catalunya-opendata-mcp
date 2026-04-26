import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import { packageVersion } from "../../package-info.js";
import { SourceError, type SourceErrorCode } from "../common/errors.js";

export const IDESCAT_TABLES_BASE_URL = "https://api.idescat.cat/taules/v2";
export const IDESCAT_ERROR_BODY_MAX_BYTES = 65_536;
export const IDESCAT_ERROR_TEXT_EXCERPT_MAX_CHARS = 4_096;
export const IDESCAT_USER_AGENT = `catalunya-opendata-mcp/${packageVersion}`;

export type IdescatLanguage = "ca" | "en" | "es";

export type IdescatErrorCode = Extract<
  SourceErrorCode,
  | "http_error"
  | "invalid_input"
  | "invalid_response"
  | "narrow_filters"
  | "network_error"
  | "timeout"
>;

export class IdescatError extends SourceError<"idescat"> {
  constructor(
    code: IdescatErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      source_error?: unknown;
      status?: number;
    } = {},
  ) {
    super("idescat", code, message, options);
    this.name = "IdescatError";
  }
}

export interface IdescatHttpRequest {
  body?: URLSearchParams;
  method?: "GET" | "POST";
  url: URL;
}

export interface FetchIdescatJsonOptions {
  logger?: Logger;
  signal?: AbortSignal;
}

export function isIdescatError(error: unknown): error is IdescatError {
  return error instanceof IdescatError;
}

export async function fetchIdescatJson(
  request: IdescatHttpRequest,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<unknown> {
  const logger = options.logger ?? createLogger(config).child({ source: "idescat" });
  const startedAt = performance.now();
  let response: Response;

  try {
    response = await fetchIdescatUrl(request, config, options);
  } catch (error) {
    logIdescatFetchFailure(logger, request.url, startedAt, error);
    throw error;
  }

  try {
    if (!response.ok) {
      throw await createHttpError(response);
    }

    const bodyText = await readBodyText(response, config.idescatUpstreamReadBytes, "success");
    const parsed = parseJson(bodyText);

    if (isJsonStatErrorPayload(parsed)) {
      throw toJsonStatError(parsed, response.status);
    }

    logger.debug("upstream_request", {
      url: request.url.toString(),
      status: response.status,
      durationMs: getDurationMs(startedAt),
      retryable: false,
    });

    return parsed;
  } catch (error) {
    // Single warn site for any post-fetch failure (non-2xx, JSON-stat error,
    // invalid JSON, oversized body). Network errors are already logged in the
    // outer fetch catch above.
    logIdescatFetchFailure(logger, request.url, startedAt, error);
    throw error;
  }
}

async function fetchIdescatUrl(
  request: IdescatHttpRequest,
  config: AppConfig,
  options: FetchIdescatJsonOptions,
): Promise<Response> {
  try {
    return await fetch(request.url, {
      body: request.body,
      headers: buildHeaders(request),
      method: request.method ?? "GET",
      signal: createRequestSignal(config.requestTimeoutMs, options.signal),
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

function buildHeaders(request: IdescatHttpRequest): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": IDESCAT_USER_AGENT,
  };

  if (request.method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  return headers;
}

async function createHttpError(response: Response): Promise<IdescatError> {
  const bodyDetails = await readErrorBodyDetails(response);

  if (bodyDetails.json !== undefined && isJsonStatErrorPayload(bodyDetails.json)) {
    return toJsonStatError(bodyDetails.json, response.status);
  }

  const bodyMessage = bodyDetails.excerpt ? ` Response body: ${bodyDetails.excerpt}` : "";

  return new IdescatError(
    "http_error",
    `IDESCAT request failed with HTTP ${response.status} ${response.statusText}.${bodyMessage}`,
    {
      retryable: response.status === 429 || response.status >= 500,
      source_error:
        bodyDetails.json === undefined
          ? bodyDetails.excerpt
            ? { kind: "text_excerpt", excerpt: bodyDetails.excerpt }
            : undefined
          : bodyDetails.json,
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
    const text = await readBodyText(response, IDESCAT_ERROR_BODY_MAX_BYTES, "error");
    const collapsed = text.replace(/\s+/g, " ").trim();
    const json = parseJsonSafely(text);

    if (json !== undefined) {
      return { excerpt: collapsed || null, json };
    }

    if (!collapsed) {
      return { excerpt: null };
    }

    return {
      excerpt:
        collapsed.length > IDESCAT_ERROR_TEXT_EXCERPT_MAX_CHARS
          ? `${collapsed.slice(0, IDESCAT_ERROR_TEXT_EXCERPT_MAX_CHARS)}...`
          : collapsed,
    };
  } catch {
    return { excerpt: null };
  }
}

async function readBodyText(
  response: Response,
  maxBytes: number,
  kind: "error" | "success",
): Promise<string> {
  // Success bodies must throw on overflow so we never feed a truncated payload
  // to the JSON-stat parser. Error bodies keep the buffered prefix as an
  // excerpt — the plan says non-2xx reads should always surface useful
  // diagnostic context, so an oversized error body becomes a truncated text
  // excerpt rather than disappearing.
  const bodyBytes = await readBodyBytes(
    response,
    maxBytes,
    kind === "success" ? "throw" : "truncate",
  );
  return new TextDecoder().decode(bodyBytes);
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
        throw new IdescatError(
          "invalid_response",
          "IDESCAT upstream success body exceeded the configured read cap.",
        );
      }
      // truncate: copy only the first maxBytes so the caller can still surface
      // a useful excerpt. Trim the last chunk if needed, then drop any chunks
      // beyond the cap.
      const bodyBytes = new Uint8Array(maxBytes);
      let offset = 0;
      for (const chunk of chunks) {
        const remaining = maxBytes - offset;
        if (remaining <= 0) break;
        const slice = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
        bodyBytes.set(slice, offset);
        offset += slice.byteLength;
      }
      return bodyBytes;
    }

    const bodyBytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bodyBytes;
  } catch (error) {
    if (isIdescatError(error)) {
      throw error;
    }

    throw new IdescatError("invalid_response", "IDESCAT response body could not be read.", {
      cause: error,
    });
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new IdescatError("invalid_response", "IDESCAT returned invalid JSON.", {
      cause: error,
    });
  }
}

function parseJsonSafely(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isJsonStatErrorPayload(value: unknown): value is {
  class: "error";
  id?: unknown;
  label?: unknown;
  status?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "class" in value &&
    (value as { class?: unknown }).class === "error"
  );
}

function toJsonStatError(
  value: {
    id?: unknown;
    label?: unknown;
    status?: unknown;
  },
  responseStatus?: number,
): IdescatError {
  const status = normalizeStatus(value.status, responseStatus);
  const id = typeof value.id === "string" ? value.id : undefined;
  const label = typeof value.label === "string" ? value.label : "IDESCAT returned an error.";

  if (id === "05" || status === 416) {
    return new IdescatError("narrow_filters", label, {
      retryable: false,
      source_error: value,
      status,
    });
  }

  if (id === "00" || status >= 500) {
    return new IdescatError("http_error", label, {
      retryable: true,
      source_error: value,
      status,
    });
  }

  return new IdescatError("invalid_input", label, {
    retryable: false,
    source_error: value,
    status,
  });
}

function normalizeStatus(status: unknown, fallback = 500): number {
  if (typeof status === "number" && Number.isInteger(status)) {
    return status;
  }

  if (typeof status === "string") {
    const parsed = Number.parseInt(status, 10);

    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function createRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([signal, timeoutSignal]);
}

function toFetchError(error: unknown): IdescatError {
  const name = getErrorName(error);

  if (name === "TimeoutError" || name === "AbortError") {
    return new IdescatError("timeout", "IDESCAT request timed out.", {
      cause: error,
      retryable: true,
    });
  }

  return new IdescatError("network_error", "IDESCAT request failed.", {
    cause: error,
    retryable: true,
  });
}

function logIdescatFetchFailure(logger: Logger, url: URL, startedAt: number, error: unknown): void {
  const isIdescat = error instanceof IdescatError;

  logger.warn("upstream_request", {
    url: url.toString(),
    status: isIdescat ? error.status : undefined,
    durationMs: getDurationMs(startedAt),
    code: isIdescat ? error.code : "unknown",
    retryable: isIdescat ? error.retryable : undefined,
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
