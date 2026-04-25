import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors the silent log level", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger({ logLevel: "silent" }).child({ source: "socrata" });

    logger.error("hidden", { op: "query" });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("writes structured JSON with child context", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger({ logLevel: "debug" })
      .child({ source: "socrata" })
      .child({ op: "dataset_query" });

    logger.debug("upstream_request", {
      status: 200,
      durationMs: 12,
    });

    expect(consoleError).toHaveBeenCalledTimes(1);

    const record = JSON.parse(String(consoleError.mock.calls[0][0]));

    expect(record).toMatchObject({
      level: "debug",
      message: "upstream_request",
      source: "socrata",
      op: "dataset_query",
      status: 200,
      durationMs: 12,
    });
    expect(record.time).toEqual(expect.any(String));
  });
});
