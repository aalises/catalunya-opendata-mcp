#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer, serverName } from "./mcp/server.js";

const server = createMcpServer();
const transport = new StdioServerTransport();

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await server.close();
  } catch (error) {
    console.error(`${serverName} failed to close after ${signal}.`, error);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await server.connect(transport);
} catch (error) {
  console.error(`${serverName} failed to start.`, error);
  process.exit(1);
}
