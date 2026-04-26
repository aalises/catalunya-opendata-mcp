import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns narrow defaults", () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: "development",
      logLevel: "info",
      transport: "stdio",
      maxResults: 100,
      requestTimeoutMs: 30_000,
      responseMaxBytes: 262_144,
      idescatUpstreamReadBytes: 8_388_608,
      socrataAppToken: undefined,
    });
  });

  it("coerces numeric caps and trims optional secrets", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "debug",
        CATALUNYA_MCP_MAX_RESULTS: "250",
        CATALUNYA_MCP_REQUEST_TIMEOUT_MS: "5000",
        CATALUNYA_MCP_RESPONSE_MAX_BYTES: "65536",
        CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES: "1048576",
        SOCRATA_APP_TOKEN: " token ",
      }),
    ).toEqual({
      nodeEnv: "test",
      logLevel: "debug",
      transport: "stdio",
      maxResults: 250,
      requestTimeoutMs: 5_000,
      responseMaxBytes: 65_536,
      idescatUpstreamReadBytes: 1_048_576,
      socrataAppToken: "token",
    });
  });

  it("treats an empty optional token as absent", () => {
    expect(loadConfig({ SOCRATA_APP_TOKEN: " " }).socrataAppToken).toBeUndefined();
  });

  it("throws a readable error for invalid values", () => {
    expect(() => loadConfig({ CATALUNYA_MCP_MAX_RESULTS: "0" })).toThrow(
      /Invalid configuration: CATALUNYA_MCP_MAX_RESULTS/,
    );
    expect(() => loadConfig({ CATALUNYA_MCP_RESPONSE_MAX_BYTES: "1024" })).toThrow(
      /Invalid configuration: CATALUNYA_MCP_RESPONSE_MAX_BYTES/,
    );
    expect(() => loadConfig({ CATALUNYA_MCP_RESPONSE_MAX_BYTES: "32768" })).toThrow(
      /Invalid configuration: CATALUNYA_MCP_RESPONSE_MAX_BYTES/,
    );
    expect(() => loadConfig({ CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES: "1024" })).toThrow(
      /Invalid configuration: CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES/,
    );
    expect(() => loadConfig({ CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES: "67108864" })).toThrow(
      /Invalid configuration: CATALUNYA_MCP_IDESCAT_UPSTREAM_READ_BYTES/,
    );
  });
});
