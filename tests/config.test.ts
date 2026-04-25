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
      socrataAppToken: undefined,
    });
  });

  it("coerces numeric limits and trims optional secrets", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "debug",
        CATALUNYA_MCP_MAX_RESULTS: "250",
        CATALUNYA_MCP_REQUEST_TIMEOUT_MS: "5000",
        SOCRATA_APP_TOKEN: " token ",
      }),
    ).toEqual({
      nodeEnv: "test",
      logLevel: "debug",
      transport: "stdio",
      maxResults: 250,
      requestTimeoutMs: 5_000,
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
  });
});
