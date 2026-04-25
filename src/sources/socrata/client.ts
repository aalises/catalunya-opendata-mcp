import type { AppConfig } from "../../config.js";

// Use Socrata's EU federation catalog with a hard domain filter so search stays Catalonia-scoped.
export const SOCRATA_CATALOG_BASE_URL = "https://api.eu.socrata.com/api/catalog/v1";
export const SOCRATA_CATALOG_DOMAIN = "analisi.transparenciacatalunya.cat";
export const SOCRATA_USER_AGENT = "catalunya-opendata-mcp/0.1.0";

export type SocrataErrorCode =
  | "http_error"
  | "invalid_input"
  | "invalid_response"
  | "network_error"
  | "timeout";

export class SocrataError extends Error {
  readonly code: SocrataErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: SocrataErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      status?: number;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SocrataError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export interface FetchSocrataCatalogParams {
  query: string;
  limit: number;
  offset: number;
}

export interface FetchSocrataJsonOptions {
  signal?: AbortSignal;
}

export function isSocrataError(error: unknown): error is SocrataError {
  return error instanceof SocrataError;
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
  const response = await fetchSocrataUrl(url, config, options);

  if (!response.ok) {
    throw await createHttpError(response);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new SocrataError("invalid_response", "Socrata returned invalid JSON.", {
      cause: error,
    });
  }
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

async function createHttpError(response: Response): Promise<SocrataError> {
  return new SocrataError(
    "http_error",
    `Socrata request failed with HTTP ${response.status} ${response.statusText}.`,
    {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
    },
  );
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
