import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_DATASET_PATH = resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "query-datasets",
  "catalunya-opendata-queries.json",
);
const DEFAULT_REQUEST_TIMEOUT_MS = 90000;

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date();
const dataset = loadDataset(options.dataset);
const reportPath =
  options.report ??
  resolve(process.cwd(), "tmp", `query-eval-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);

const report = {
  generated_at: startedAt.toISOString(),
  package: {
    name: packageJson.name,
    version: packageJson.version,
  },
  dataset: {
    path: options.dataset,
    version: dataset.version,
    description: dataset.description,
  },
  command: {
    server: "node dist/index.js",
    request_timeout_ms: options.requestTimeoutMs,
    report_path: reportPath,
  },
  cases: [],
};

await run();

async function run() {
  const client = new Client({
    name: "catalunya-opendata-query-evaluator",
    version: packageJson.version,
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: createServerEnv(),
  });

  try {
    await client.connect(transport);

    const cases = selectCases(dataset.cases);
    for (const [index, caseDef] of cases.entries()) {
      await evaluateCase(client, caseDef, index + 1);
    }
  } finally {
    await client.close();
  }

  finalizeReport();
}

async function evaluateCase(client, caseDef, sequence) {
  const startedAtMs = performance.now();
  let result;
  let thrown;

  try {
    result = await client.callTool(
      {
        name: caseDef.tool,
        arguments: caseDef.args ?? {},
      },
      undefined,
      {
        maxTotalTimeout: options.requestTimeoutMs,
        timeout: options.requestTimeoutMs,
      },
    );
  } catch (error) {
    thrown = error;
  }

  const structuredContent = result?.structuredContent;
  const root = {
    data: isRecord(structuredContent) ? structuredContent.data : undefined,
    error: isRecord(structuredContent) ? structuredContent.error : undefined,
    isError: result?.isError === true,
    result,
    thrown: thrown ? serializeError(thrown) : undefined,
  };
  const assertions = caseDef.expect_error
    ? [evaluateExpectedError(root, caseDef.expect_error)]
    : (caseDef.assertions ?? []).map((assertion) => evaluateAssertion(root, assertion));
  const passed = assertions.every((assertion) => assertion.passed);
  const entry = {
    sequence,
    id: caseDef.id,
    connector: caseDef.connector,
    category: caseDef.category,
    tool: caseDef.tool,
    args: caseDef.args ?? {},
    passed,
    assertions,
    failed_assertions: assertions.filter((assertion) => !assertion.passed).length,
    duration_ms: Math.round(performance.now() - startedAtMs),
    status: thrown ? "thrown" : result?.isError ? "tool_error" : "ok",
    summary: summarizeResult(root),
  };

  report.cases.push(entry);

  if (!options.quiet || !passed) {
    console.log(
      `${String(sequence).padStart(3, "0")} ${passed ? "PASS" : "FAIL"} ${caseDef.connector} ${
        caseDef.category
      } ${caseDef.tool} :: ${caseDef.id}`,
    );

    if (!passed) {
      console.log(JSON.stringify({ assertions, summary: entry.summary }, null, 2));
    }
  }

  if (!passed && options.failFast) {
    throw new Error(`Query evaluation failed: ${caseDef.id}`);
  }
}

function evaluateExpectedError(root, expectation) {
  const error = root.error ?? root.thrown;
  const checks = [
    expectation.code === undefined || error?.code === expectation.code,
    expectation.status === undefined || error?.status === expectation.status,
    expectation.message_includes === undefined ||
      String(error?.message ?? "").includes(expectation.message_includes),
  ];

  return {
    passed: root.isError === true && checks.every(Boolean),
    op: "expect_error",
    expected: expectation,
    actual: error,
  };
}

function evaluateAssertion(root, assertion) {
  const actual = getPath(root, assertion.path);
  let passed;

  switch (assertion.op) {
    case "equals":
      passed = deepEqual(actual, assertion.value);
      break;
    case "oneOf":
      passed = assertion.values?.some((value) => deepEqual(actual, value)) === true;
      break;
    case "exists":
      passed = actual !== undefined && actual !== null;
      break;
    case "notExists":
      passed = actual === undefined || actual === null;
      break;
    case "includes":
      passed =
        (typeof actual === "string" && actual.includes(assertion.value)) ||
        (Array.isArray(actual) && actual.some((item) => deepEqual(item, assertion.value)));
      break;
    case "matches":
      passed = new RegExp(assertion.value, assertion.flags ?? "u").test(String(actual ?? ""));
      break;
    case "gt":
      passed = typeof actual === "number" && actual > assertion.value;
      break;
    case "gte":
      passed = typeof actual === "number" && actual >= assertion.value;
      break;
    case "lengthGte":
      passed = Array.isArray(actual) && actual.length >= assertion.value;
      break;
    case "some":
      passed = Array.isArray(actual) && actual.some((item) => matchesWhere(item, assertion.where));
      break;
    case "somePathIncludes":
      passed =
        Array.isArray(actual) &&
        actual.some((item) =>
          String(getPath(item, assertion.itemPath) ?? "").includes(String(assertion.value)),
        );
      break;
    default:
      throw new Error(
        `Unsupported assertion op ${JSON.stringify(assertion.op)} in ${assertion.path}`,
      );
  }

  return {
    passed,
    path: assertion.path,
    op: assertion.op,
    expected:
      assertion.value ??
      assertion.values ??
      assertion.where ??
      assertion.itemPath ??
      assertion.message_includes,
    actual,
  };
}

function matchesWhere(value, where) {
  if (!isRecord(value) || !isRecord(where)) {
    return false;
  }

  return Object.entries(where).every(([path, expected]) =>
    deepEqual(getPath(value, path), expected),
  );
}

function getPath(value, path) {
  if (!path) {
    return value;
  }

  return String(path)
    .split(".")
    .reduce((current, part) => {
      if (current === undefined || current === null) {
        return undefined;
      }

      if (Array.isArray(current) && /^\d+$/u.test(part)) {
        return current[Number(part)];
      }

      return current[part];
    }, value);
}

function summarizeResult(root) {
  const data = root.data;

  if (root.thrown) {
    return { thrown: root.thrown };
  }

  if (root.isError) {
    return { error: root.error };
  }

  if (!isRecord(data)) {
    return { data_type: typeof data };
  }

  return {
    status: data.status,
    execution_status: data.execution_status,
    answer_type: data.answer_type,
    row_count: data.row_count,
    matched_row_count: data.matched_row_count ?? data.final_result?.data?.matched_row_count,
    scanned_row_count: data.scanned_row_count ?? data.final_result?.data?.scanned_row_count,
    candidate_count: data.candidate_count,
    recommendation_count: data.recommendation_count,
    first_result_id: data.results?.[0]?.source_id ?? data.results?.[0]?.statistics_id,
  };
}

function finalizeReport() {
  const failed = report.cases.filter((entry) => !entry.passed);
  const byConnector = countBy(report.cases, "connector");
  const byCategory = countBy(report.cases, "category");

  report.completed_at = new Date().toISOString();
  report.duration_ms = new Date(report.completed_at).getTime() - startedAt.getTime();
  report.summary = {
    total_cases: report.cases.length,
    passed_cases: report.cases.length - failed.length,
    failed_cases: failed.length,
    score:
      report.cases.length === 0 ? 0 : (report.cases.length - failed.length) / report.cases.length,
    by_connector: withPassFail(report.cases, byConnector, "connector"),
    by_category: withPassFail(report.cases, byCategory, "category"),
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        dataset: options.dataset,
        reportPath,
        summary: report.summary,
        failures: failed.map((entry) => ({
          id: entry.id,
          assertions: entry.assertions.filter((assertion) => !assertion.passed),
          summary: entry.summary,
        })),
      },
      null,
      2,
    ),
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function selectCases(cases) {
  let selected = cases;

  if (options.filter) {
    selected = selected.filter(
      (caseDef) =>
        caseDef.id.includes(options.filter) ||
        caseDef.connector === options.filter ||
        caseDef.category === options.filter,
    );
  }

  if (options.limit !== undefined) {
    selected = selected.slice(0, options.limit);
  }

  return selected;
}

function loadDataset(path) {
  if (!existsSync(path)) {
    throw new Error(`Query evaluation dataset not found: ${path}`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(parsed.cases)) {
    throw new Error(`Query evaluation dataset must contain a cases array: ${path}`);
  }

  const ids = new Set();
  for (const caseDef of parsed.cases) {
    if (!caseDef.id || !caseDef.tool) {
      throw new Error(`Invalid query evaluation case: ${JSON.stringify(caseDef)}`);
    }

    if (ids.has(caseDef.id)) {
      throw new Error(`Duplicate query evaluation case id: ${caseDef.id}`);
    }

    ids.add(caseDef.id);
  }

  return parsed;
}

function parseArgs(argv) {
  const parsed = {
    dataset: DEFAULT_DATASET_PATH,
    failFast: false,
    filter: undefined,
    limit: undefined,
    quiet: false,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    report: undefined,
  };

  for (const arg of argv) {
    if (arg === "--fail-fast") {
      parsed.failFast = true;
      continue;
    }

    if (arg === "--quiet") {
      parsed.quiet = true;
      continue;
    }

    const [key, value] = arg.split("=", 2);

    if (key === "--dataset" && value) {
      parsed.dataset = resolve(process.cwd(), value);
      continue;
    }

    if (key === "--filter" && value) {
      parsed.filter = value;
      continue;
    }

    if (key === "--limit" && value) {
      parsed.limit = Number(value);
      continue;
    }

    if (key === "--report" && value) {
      parsed.report = resolve(process.cwd(), value);
      continue;
    }

    if (key === "--timeout-ms" && value) {
      parsed.requestTimeoutMs = Number(value);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(parsed.requestTimeoutMs) || parsed.requestTimeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }

  return parsed;
}

function createServerEnv() {
  return {
    LOG_LEVEL: "silent",
    CATALUNYA_MCP_REQUEST_TIMEOUT_MS:
      process.env.CATALUNYA_MCP_REQUEST_TIMEOUT_MS ?? String(options.requestTimeoutMs),
    ...(process.env.SOCRATA_APP_TOKEN ? { SOCRATA_APP_TOKEN: process.env.SOCRATA_APP_TOKEN } : {}),
  };
}

function countBy(items, key) {
  const counts = {};

  for (const item of items) {
    counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  }

  return counts;
}

function withPassFail(cases, counts, key) {
  return Object.fromEntries(
    Object.entries(counts).map(([value, total]) => {
      const failed = cases.filter((entry) => entry[key] === value && !entry.passed).length;
      return [value, { total, passed: total - failed, failed }];
    }),
  );
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.status,
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
