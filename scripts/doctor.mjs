import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const options = parseArgs(process.argv.slice(2));
const results = [];

await runCheck("runtime", () => {
  const nodeVersion = process.versions.node;
  const npmVersion = execFileSync("npm", ["-v"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  assertMinimumVersion(nodeVersion, "22.12.0", "Node.js");

  return {
    node: nodeVersion,
    npm: npmVersion,
    required_node: packageJson.engines?.node ?? null,
  };
});

await runCheck("configuration", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const config = loadConfig(process.env);

  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    transport: config.transport,
    maxResults: config.maxResults,
    requestTimeoutMs: config.requestTimeoutMs,
    responseMaxBytes: config.responseMaxBytes,
    idescatUpstreamReadBytes: config.idescatUpstreamReadBytes,
    bcnUpstreamReadBytes: config.bcnUpstreamReadBytes,
    bcnGeoScanMaxRows: config.bcnGeoScanMaxRows,
    bcnGeoScanBytes: config.bcnGeoScanBytes,
    socrataAppToken: config.socrataAppToken === undefined ? "unset" : "set",
  };
});

await runCheck("build output", () => {
  const entrypoint = path.join(rootDir, "dist/index.js");
  const stat = statSync(entrypoint);
  accessSync(entrypoint, constants.X_OK);

  return {
    entrypoint: "dist/index.js",
    executable: true,
    sizeBytes: stat.size,
  };
});

await runCheck("package budget", () => {
  const result = runCommand("node", ["scripts/package-size.mjs"]);

  return {
    output: result.stdout.trim().split("\n"),
  };
});

if (!options.skipSmoke) {
  await runCheck("stdio smoke", () => {
    runCommand("node", ["scripts/smoke.mjs"], {
      env: {
        ...process.env,
        LOG_LEVEL: "silent",
      },
    });

    return "MCP surface and ping passed";
  });
}

if (!options.skipUpstream) {
  await runCheck("upstream reachability", async () => {
    const endpoints = [
      {
        name: "Socrata catalog",
        url: "https://api.eu.socrata.com/api/catalog/v1?domains=analisi.transparenciacatalunya.cat&limit=1",
      },
      {
        name: "IDESCAT Tables v2",
        url: "https://api.idescat.cat/taules/v2?lang=ca",
      },
      {
        name: "Open Data BCN CKAN",
        url: "https://opendata-ajuntament.barcelona.cat/data/api/3/action/package_search?rows=1",
      },
    ];

    return Promise.all(endpoints.map(checkEndpoint));
  });
}

const failed = results.filter((result) => !result.ok);
const summary = {
  ok: failed.length === 0,
  package: {
    name: packageJson.name,
    version: packageJson.version,
  },
  results,
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("");
  console.log(summary.ok ? "doctor passed" : "doctor found problems");
}

if (!summary.ok) {
  process.exitCode = 1;
}

async function runCheck(name, fn) {
  const startedAt = performance.now();

  try {
    const detail = await fn();
    const result = {
      name,
      ok: true,
      duration_ms: Math.round(performance.now() - startedAt),
      detail,
    };
    results.push(result);

    if (!options.json) {
      console.log(`PASS ${name}: ${formatDetail(detail)}`);
    }
  } catch (error) {
    const result = {
      name,
      ok: false,
      duration_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(result);

    if (!options.json) {
      console.error(`FAIL ${name}: ${result.error}`);
    }
  }
}

function runCommand(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}.\n${result.stdout}\n${result.stderr}`.trim(),
    );
  }

  return result;
}

async function checkEndpoint(endpoint) {
  const startedAt = performance.now();
  const response = await fetch(endpoint.url, {
    headers: {
      "User-Agent": `${packageJson.name}/${packageJson.version} doctor`,
    },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  await response.arrayBuffer();

  if (!response.ok) {
    throw new Error(`${endpoint.name} returned HTTP ${response.status}.`);
  }

  return {
    name: endpoint.name,
    status: response.status,
    duration_ms: Math.round(performance.now() - startedAt),
  };
}

function parseArgs(args) {
  const parsed = {
    json: false,
    skipSmoke: false,
    skipUpstream: false,
    timeoutMs: 10_000,
  };

  for (const arg of args) {
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--skip-smoke") {
      parsed.skipSmoke = true;
      continue;
    }
    if (arg === "--skip-upstream") {
      parsed.skipUpstream = true;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 100) {
    throw new Error("--timeout-ms must be an integer >= 100.");
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/doctor.mjs [--skip-smoke] [--skip-upstream] [--timeout-ms=10000] [--json]

Checks runtime, configuration, build output, package budget, stdio smoke, and upstream reachability.
Use npm run doctor to build first, then run the diagnostic checks.
`);
  process.exit(0);
}

function assertMinimumVersion(actual, minimum, label) {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);

  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) {
      return;
    }
    if (actualParts[index] < minimumParts[index]) {
      throw new Error(`${label} ${actual} is below required ${minimum}.`);
    }
  }
}

function parseVersion(value) {
  return value
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

function formatDetail(detail) {
  if (typeof detail === "string") {
    return detail;
  }

  return JSON.stringify(detail);
}
