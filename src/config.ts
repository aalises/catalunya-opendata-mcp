import { z } from "zod";

const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "silent"]);
const nodeEnvSchema = z.enum(["development", "test", "production"]);
const transportSchema = z.enum(["stdio"]);

function emptyStringAsUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const optionalSecretSchema = z.preprocess(
  emptyStringAsUndefined,
  z.string().trim().min(1).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(emptyStringAsUndefined, nodeEnvSchema.default("development")),
    LOG_LEVEL: z.preprocess(emptyStringAsUndefined, logLevelSchema.default("info")),
    CATALUNYA_MCP_TRANSPORT: z.preprocess(emptyStringAsUndefined, transportSchema.default("stdio")),
    CATALUNYA_MCP_MAX_RESULTS: z.preprocess(
      emptyStringAsUndefined,
      z.coerce.number().int().min(1).max(1_000).default(100),
    ),
    CATALUNYA_MCP_REQUEST_TIMEOUT_MS: z.preprocess(
      emptyStringAsUndefined,
      z.coerce.number().int().min(100).max(120_000).default(30_000),
    ),
    // Floor of 65 KiB absorbs the worst-case empty-rows envelope: four 4 KiB clauses plus
    // request_url, logical_request_url, and provenance.source_url at the 8 KiB URL cap.
    CATALUNYA_MCP_RESPONSE_MAX_BYTES: z.preprocess(
      emptyStringAsUndefined,
      z.coerce.number().int().min(65_536).max(1_048_576).default(262_144),
    ),
    CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES: z.preprocess(
      emptyStringAsUndefined,
      z.coerce.number().int().min(65_536).max(33_554_432).default(8_388_608),
    ),
    SOCRATA_APP_TOKEN: optionalSecretSchema,
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    transport: env.CATALUNYA_MCP_TRANSPORT,
    maxResults: env.CATALUNYA_MCP_MAX_RESULTS,
    requestTimeoutMs: env.CATALUNYA_MCP_REQUEST_TIMEOUT_MS,
    responseMaxBytes: env.CATALUNYA_MCP_RESPONSE_MAX_BYTES,
    idescatUpstreamReadBytes: env.CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES,
    socrataAppToken: env.SOCRATA_APP_TOKEN,
  }));

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(formatConfigError(parsed.error));
  }

  return parsed.data;
}

function formatConfigError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");

  return `Invalid configuration: ${issues}`;
}
