import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import { packageVersion } from "../../package-info.js";
import { SourceError, type SourceErrorCode } from "../common/errors.js";

// Use Socrata's EU federation catalog with a hard domain filter so search stays Catalonia-scoped.
export const SOCRATA_CATALOG_BASE_URL = "https://api.eu.socrata.com/api/catalog/v1";
export const SOCRATA_CATALOG_DOMAIN = "analisi.transparenciacatalunya.cat";
export const SOCRATA_ERROR_BODY_MAX_BYTES = 4_096;
export const SOCRATA_ERROR_BODY_MAX_CHARS = 2_000;
export const SOCRATA_SOURCE_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
export const SOCRATA_SUCCESS_BODY_MAX_BYTES = 1_048_576;
export const SOCRATA_USER_AGENT = `catalunya-opendata-mcp/${packageVersion}`;

export type SocrataErrorCode = Extract<
  SourceErrorCode,
  "http_error" | "invalid_input" | "invalid_response" | "network_error" | "timeout"
>;

export class SocrataError extends SourceError<"socrata"> {
  constructor(
    code: SocrataErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      status?: number;
    } = {},
  ) {
    super("socrata", code, message, options);
    this.name = "SocrataError";
  }
}

export interface FetchSocrataCatalogParams {
  query: string;
  limit: number;
  offset: number;
}

export interface FetchSocrataJsonOptions {
  logger?: Logger;
  signal?: AbortSignal;
  successBodyMaxBytes?: number;
}

export function isSocrataError(error: unknown): error is SocrataError {
  return error instanceof SocrataError;
}

export function normalizeSourceId(sourceId: string): string {
  const trimmedSourceId = sourceId.trim();

  if (!SOCRATA_SOURCE_ID_PATTERN.test(trimmedSourceId)) {
    const display = JSON.stringify(sourceId.slice(0, 64));
    throw new SocrataError(
      "invalid_input",
      `source_id ${display} is not a Socrata four-by-four identifier (expected ${SOCRATA_SOURCE_ID_PATTERN}).`,
    );
  }

  return trimmedSourceId;
}

export function buildSocrataCatalogUrl(params: FetchSocrataCatalogParams): URL {
  const url = new URL(SOCRATA_CATALOG_BASE_URL);
  url.searchParams.set("domains", SOCRATA_CATALOG_DOMAIN);
  url.searchParams.set("only", "dataset");
  url.searchParams.set("q", params.query);
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("offset", String(params.offset));

  return url;
}

export async function fetchSocrataJson(
  url: URL,
  config: AppConfig,
  options: FetchSocrataJsonOptions = {},
): Promise<unknown> {
  const logger = options.logger ?? createLogger(config).child({ source: "socrata" });
  const startedAt = performance.now();
  let response: Response;

  try {
    response = await fetchSocrataUrl(url, config, options);
  } catch (error) {
    logSocrataFetchFailure(logger, url, startedAt, error);
    throw error;
  }

  if (!response.ok) {
    const error = await createHttpError(response, config);
    logger.warn("upstream_request", {
      url: url.toString(),
      status: response.status,
      durationMs: getDurationMs(startedAt),
      code: error.code,
      retryable: error.retryable,
    });
    throw error;
  }

  const bodyText = await readSuccessBodyText(
    response,
    options.successBodyMaxBytes ?? config.responseMaxBytes,
  ).catch((error: unknown) => {
    logSocrataFetchFailure(logger, url, startedAt, error);
    throw error;
  });

  try {
    const parsed = JSON.parse(bodyText);

    logger.debug("upstream_request", {
      url: url.toString(),
      status: response.status,
      durationMs: getDurationMs(startedAt),
      retryable: false,
    });

    return parsed;
  } catch (error) {
    const socrataError = new SocrataError("invalid_response", "Socrata returned invalid JSON.", {
      cause: error,
    });
    logSocrataFetchFailure(logger, url, startedAt, socrataError);
    throw socrataError;
  }
}

function logSocrataFetchFailure(
  logger: Logger,
  url: URL,
  startedAt: number,
  error: unknown,
): void {
  const isSocrata = error instanceof SocrataError;

  logger.warn("upstream_request", {
    url: url.toString(),
    status: isSocrata ? error.status : undefined,
    durationMs: getDurationMs(startedAt),
    code: isSocrata ? error.code : "unknown",
    retryable: isSocrata ? error.retryable : undefined,
    error,
  });
}

function getDurationMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function fetchSocrataUrl(
  url: URL,
  config: AppConfig,
  options: FetchSocrataJsonOptions,
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: buildHeaders(config),
      signal: createRequestSignal(config.requestTimeoutMs, options.signal),
    });
  } catch (error) {
    throw toFetchError(error);
  }
}

function buildHeaders(config: AppConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": SOCRATA_USER_AGENT,
  };

  if (config.socrataAppToken) {
    headers["X-App-Token"] = config.socrataAppToken;
  }

  return headers;
}

async function createHttpError(response: Response, config: AppConfig): Promise<SocrataError> {
  const bodyExcerpt = await readErrorBodyExcerpt(response, config);
  const bodyMessage = bodyExcerpt ? ` Response body: ${bodyExcerpt}` : "";

  return new SocrataError(
    "http_error",
    `Socrata request failed with HTTP ${response.status} ${response.statusText}.${bodyMessage}`,
    {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    },
  );
}

async function readSuccessBodyText(response: Response, maxBytes: number): Promise<string> {
  const bodyBytes = await readSuccessBodyBytes(response, maxBytes);

  return new TextDecoder().decode(bodyBytes);
}

async function readSuccessBodyBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
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
      throw new SocrataError(
        "invalid_response",
        `Socrata response body exceeded maximum size of ${maxBytes} bytes.`,
      );
    }

    const bodyBytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bodyBytes;
  } catch (error) {
    if (isSocrataError(error)) {
      throw error;
    }

    throw new SocrataError("invalid_response", "Socrata response body could not be read.", {
      cause: error,
    });
  }
}

async function readErrorBodyExcerpt(response: Response, config: AppConfig): Promise<string | null> {
  if (!response.body) {
    return null;
  }

  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let truncated = false;

    while (byteLength < SOCRATA_ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remainingBytes = SOCRATA_ERROR_BODY_MAX_BYTES - byteLength;

      if (value.byteLength > remainingBytes) {
        chunks.push(value.slice(0, remainingBytes));
        byteLength += remainingBytes;
        truncated = true;
        break;
      }

      chunks.push(value);
      byteLength += value.byteLength;
    }

    if (byteLength >= SOCRATA_ERROR_BODY_MAX_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
    }

    if (byteLength === 0) {
      return null;
    }

    const bodyBytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Redact before whitespace-collapse so a token that happens to be split across
    // newlines or padded by Socrata is still caught by the literal-substring scrub.
    const decoded = new TextDecoder().decode(bodyBytes);
    const redacted = redactSecrets(decoded, config).replace(/\s+/g, " ").trim();

    if (!redacted) {
      return null;
    }

    if (redacted.length > SOCRATA_ERROR_BODY_MAX_CHARS) {
      return `${redacted.slice(0, SOCRATA_ERROR_BODY_MAX_CHARS)}...`;
    }

    return truncated ? `${redacted}...` : redacted;
  } catch {
    return null;
  }
}

// Belt-and-suspenders: Socrata should not echo X-App-Token in error bodies, but if a future
// upstream change ever does, we don't want to leak it through SocrataError.message.
function redactSecrets(value: string, config: AppConfig): string {
  const token = config.socrataAppToken;

  if (!token) {
    return value;
  }

  return value.split(token).join("[redacted]");
}

function createRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([signal, timeoutSignal]);
}

function toFetchError(error: unknown): SocrataError {
  const name = getErrorName(error);

  if (name === "TimeoutError" || name === "AbortError") {
    return new SocrataError("timeout", "Socrata request timed out.", {
      cause: error,
      retryable: true,
    });
  }

  return new SocrataError("network_error", "Socrata request failed.", {
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
