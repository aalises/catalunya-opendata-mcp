import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBcnActionUrl,
  fetchBcnActionResult,
  fetchBcnJson,
} from "../../../src/sources/bcn/client.js";
import { baseConfig, ckanFailure, ckanSuccess, jsonResponse } from "./helpers.js";

describe("Open Data BCN client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses bcnUpstreamReadBytes for successful CKAN bodies", async () => {
    const largeValue = "x".repeat(1_100_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ value: largeValue }));

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).resolves.toEqual({
      value: largeValue,
    });
  });

  it("rejects successful upstream bodies that exceed the configured read cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ value: "x".repeat(128) }));

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig, {
        successBodyMaxBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "Open Data BCN response body exceeded maximum size of 32 bytes.",
      retryable: false,
    });
  });

  it("maps CKAN success:false envelopes to typed errors with retryability", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ckanFailure({
        __type: "OperationalError",
        message: "database temporarily unavailable",
      }),
    );

    await expect(
      fetchBcnActionResult({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).rejects.toMatchObject({
      source: "bcn",
      code: "http_error",
      message: "Open Data BCN CKAN error (OperationalError): database temporarily unavailable",
      retryable: true,
      source_error: {
        __type: "OperationalError",
        message: "database temporarily unavailable",
      },
    });
  });

  it("preserves non-retryable CKAN validation errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ckanFailure({
        __type: "Validation Error",
        message: "Missing value",
      }),
    );

    await expect(
      fetchBcnActionResult({ url: buildBcnActionUrl("resource_show") }, baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      retryable: false,
    });
  });

  it("rejects invalid JSON bodies and bounded HTTP excerpts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "Open Data BCN returned invalid JSON.",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{\n  "message": "bad request"\n}', {
        headers: { "Content-Type": "application/json" },
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: expect.stringContaining('Response body: { "message": "bad request" }'),
      retryable: false,
      status: 400,
      source_error: {
        message: "bad request",
      },
    });
  });

  it("retries retryable HTTP responses before returning JSON", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("temporary", {
          status: 503,
          statusText: "Service Temporarily Unavailable",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps network and timeout failures to retryable errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("socket closed"));

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });

    vi.restoreAllMocks();
    const timeoutError = new Error("deadline");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);

    await expect(
      fetchBcnJson({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("unwraps successful CKAN results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ckanSuccess({ ok: true }));

    await expect(
      fetchBcnActionResult({ url: buildBcnActionUrl("package_search") }, baseConfig),
    ).resolves.toEqual({ ok: true });
  });
});
