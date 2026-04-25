#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { type AppConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createMcpServer, serverName } from "./mcp/server.js";

const config = loadConfig();
const logger = createLogger(config).child({ component: "server" });
const server = createMcpServer(config);
const transport = createTransport(config.transport);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await server.close();
  } catch (error) {
    logger.error("server_close_failed", {
      signal,
      error,
    });
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
  logger.error("server_start_failed", {
    server: serverName,
    error,
  });
  process.exit(1);
}

function createTransport(transport: AppConfig["transport"]): StdioServerTransport {
  switch (transport) {
    case "stdio":
      return new StdioServerTransport();
    default: {
      const _exhaustive: never = transport;
      throw new Error(`Unsupported transport: ${String(_exhaustive)}`);
    }
  }
}
