import type { AppConfig } from "./config.js";

const logLevelPriority = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: Number.POSITIVE_INFINITY,
} as const satisfies Record<AppConfig["logLevel"], number>;

export type LogFields = Record<string, unknown>;

export interface Logger {
  child(context: LogFields): Logger;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(config: Pick<AppConfig, "logLevel">, context: LogFields = {}): Logger {
  return new JsonLogger(config.logLevel, context);
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: AppConfig["logLevel"],
    private readonly context: LogFields,
  ) {}

  child(context: LogFields): Logger {
    return new JsonLogger(this.level, {
      ...this.context,
      ...context,
    });
  }

  trace(message: string, fields: LogFields = {}): void {
    this.write("trace", message, fields);
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(
    level: Exclude<AppConfig["logLevel"], "silent">,
    message: string,
    fields: LogFields,
  ): void {
    if (logLevelPriority[level] < logLevelPriority[this.level]) {
      return;
    }

    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        message,
        ...normalizeLogFields(this.context),
        ...normalizeLogFields(fields),
      }),
    );
  }
}

function normalizeLogFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, normalizeLogValue(value)]),
  );
}

function normalizeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: normalizeLogValue(value.cause) } : {}),
    };
  }

  return value;
}
