import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../src/config.js";
import {
  fetchSocrataJson,
  SOCRATA_ERROR_BODY_MAX_BYTES,
} from "../../../src/sources/socrata/client.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  logLevel: "silent",
  transport: "stdio",
  maxResults: 100,
  requestTimeoutMs: 5_000,
  responseMaxBytes: 262_144,
  socrataAppToken: undefined,
};

describe("fetchSocrataJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses successful response bodies under the configured byte cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(fetchSocrataJson(new URL("https://example.test"), baseConfig)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects successful response bodies above the configured byte cap before JSON parse", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ value: "x".repeat(80) }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), {
        ...baseConfig,
        responseMaxBytes: 20,
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "Socrata response body exceeded maximum size of 20 bytes.",
      retryable: false,
    });
  });

  it("still reports invalid JSON under the configured byte cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "Socrata returned invalid JSON.",
      retryable: false,
    });
  });

  it("appends a collapsed bounded body excerpt to HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{\n  "message": "bad where"\n}', {
        headers: { "Content-Type": "application/json" },
        status: 400,
        statusText: "Bad Request",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: expect.stringContaining('Response body: { "message": "bad where" }'),
      retryable: false,
      status: 400,
    });
  });

  it("preserves retryability while including body excerpts for retryable statuses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: expect.stringContaining("slow down"),
      retryable: true,
      status: 429,
    });
  });

  it("keeps the original HTTP error message when the response body is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 404,
        statusText: "Not Found",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: "Socrata request failed with HTTP 404 Not Found.",
      status: 404,
    });
  });

  it("does not read beyond the configured error body byte cap", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode("x".repeat(SOCRATA_ERROR_BODY_MAX_BYTES + 20)),
      })
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode("should not be read"),
      });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(SOCRATA_ERROR_BODY_MAX_BYTES + 20)));
      },
    });
    vi.spyOn(body, "getReader").mockReturnValue({
      read,
      cancel,
      closed: Promise.resolve(undefined),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: expect.stringContaining(`${"x".repeat(20)}`),
      retryable: true,
      status: 500,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("treats whitespace-only error bodies as no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("\n  \n", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: "Socrata request failed with HTTP 502 Bad Gateway.",
      retryable: true,
      status: 502,
    });
  });

  it("redacts the configured Socrata app token from error body excerpts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"echoed_token":"super-secret-token","msg":"bad"}', {
        headers: { "Content-Type": "application/json" },
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const error = await fetchSocrataJson(new URL("https://example.test"), {
      ...baseConfig,
      socrataAppToken: "super-secret-token",
    }).then(
      () => {
        throw new Error("expected fetchSocrataJson to reject");
      },
      (rejection: unknown) => rejection as { message: string },
    );

    expect(error.message).not.toContain("super-secret-token");
    expect(error.message).toContain("[redacted]");
  });

  it("keeps the original HTTP error message when body reading fails", async () => {
    const body = new ReadableStream();
    vi.spyOn(body, "getReader").mockReturnValue({
      read: vi.fn().mockRejectedValue(new Error("boom")),
      cancel: vi.fn(),
      closed: Promise.resolve(undefined),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(
      fetchSocrataJson(new URL("https://example.test"), baseConfig),
    ).rejects.toMatchObject({
      code: "http_error",
      message: "Socrata request failed with HTTP 500 Internal Server Error.",
      retryable: true,
      status: 500,
    });
  });
});
