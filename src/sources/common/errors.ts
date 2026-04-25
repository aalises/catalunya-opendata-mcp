export type SourceId = "bcn" | "idescat" | "socrata";

export type SourceErrorCode =
  | "cell_overflow"
  | "http_error"
  | "invalid_input"
  | "invalid_response"
  | "narrow_filters"
  | "network_error"
  | "timeout";

export class SourceError<TSource extends SourceId = SourceId> extends Error {
  readonly source: TSource;
  readonly code: SourceErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly source_error?: unknown;

  constructor(
    source: TSource,
    code: SourceErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      source_error?: unknown;
      status?: number;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.source = source;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.source_error = options.source_error;
  }
}

export function isSourceError(error: unknown): error is SourceError {
  return error instanceof SourceError;
}
