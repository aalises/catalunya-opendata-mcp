import { describe, expect, it } from "vitest";

import { createJsonTextContent } from "../../../src/sources/common/caps.js";
import { toJsonSafeValue } from "../../../src/sources/common/json-safe.js";

class CustomClass {
  value = "hidden";
}

describe("toJsonSafeValue", () => {
  it("normalizes non-JSON primitives and objects without throwing", () => {
    const circular: Record<string, unknown> = {
      keep: "yes",
    };
    circular.self = circular;

    const value = {
      bigint: 123n,
      error: new TypeError("bad value"),
      url: new URL("https://example.com/path?q=1"),
      circular,
      fn: () => "nope",
      instance: new CustomClass(),
      nil: null,
    };

    expect(toJsonSafeValue(value)).toEqual({
      bigint: "123",
      error: {
        name: "TypeError",
        message: "bad value",
      },
      url: "https://example.com/path?q=1",
      circular: {
        keep: "yes",
      },
      nil: null,
    });
  });

  it("turns unsafe array values into null placeholders", () => {
    const values: unknown[] = [1n, () => "nope", new CustomClass()];

    expect(toJsonSafeValue(values)).toEqual(["1", null, null]);
  });
});

describe("createJsonTextContent", () => {
  it("never throws when structured content contains unsafe values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const content = createJsonTextContent({
      url: new URL("https://example.com"),
      bad: () => undefined,
      circular,
    });

    expect(() => JSON.parse(content[0]?.text ?? "")).not.toThrow();
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({
      url: "https://example.com/",
      circular: {},
    });
  });
});
