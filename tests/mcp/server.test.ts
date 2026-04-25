import { describe, expect, it } from "vitest";

import { createPingMessage, serverName } from "../../src/mcp/server.js";

describe("createPingMessage", () => {
  it("returns the default health message", () => {
    expect(createPingMessage()).toBe(`Hola. ${serverName} is running.`);
  });

  it("includes the provided name", () => {
    expect(createPingMessage("Albert")).toBe(`Hola, Albert. ${serverName} is running.`);
  });
});
