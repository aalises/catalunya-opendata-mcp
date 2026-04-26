import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const srcSearchIndexDir = path.join(rootDir, "src/sources/idescat/search-index");
const distSearchIndexDir = path.join(rootDir, "dist/sources/idescat/search-index");

const PACKED_PACKAGE_MAX_BYTES = 512 * 1024;
const UNPACKED_PACKAGE_MAX_BYTES = 8 * 1024 * 1024;
const SRC_SEARCH_INDEX_TOTAL_MAX_BYTES = 5 * 1024 * 1024;
const DIST_SEARCH_INDEX_TOTAL_MAX_BYTES = 7 * 1024 * 1024;

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: rootDir,
  encoding: "utf8",
});
const [packSummary] = JSON.parse(packOutput);

if (!packSummary || typeof packSummary !== "object") {
  throw new Error("npm pack --dry-run did not return package metadata.");
}

const metrics = [
  {
    label: "packed package",
    observed: getRequiredNumber(packSummary, "size"),
    limit: PACKED_PACKAGE_MAX_BYTES,
  },
  {
    label: "unpacked package",
    observed: getRequiredNumber(packSummary, "unpackedSize"),
    limit: UNPACKED_PACKAGE_MAX_BYTES,
  },
  {
    label: "source IDESCAT search index",
    observed: getDirectoryByteLength(srcSearchIndexDir),
    limit: SRC_SEARCH_INDEX_TOTAL_MAX_BYTES,
  },
  {
    label: "dist IDESCAT search index",
    observed: getDirectoryByteLength(distSearchIndexDir),
    limit: DIST_SEARCH_INDEX_TOTAL_MAX_BYTES,
  },
];

for (const metric of metrics) {
  console.log(`${metric.label}: ${formatBytes(metric.observed)} / ${formatBytes(metric.limit)}`);

  if (metric.observed > metric.limit) {
    throw new Error(
      `${metric.label} is ${formatBytes(metric.observed)}, exceeds ${formatBytes(metric.limit)}.`,
    );
  }
}

function getRequiredNumber(value, key) {
  const number = value[key];

  if (!Number.isFinite(number)) {
    throw new Error(`npm pack metadata is missing numeric ${key}.`);
  }

  return number;
}

function getDirectoryByteLength(directory) {
  let total = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      total += getDirectoryByteLength(entryPath);
      continue;
    }

    total += statSync(entryPath).size;
  }

  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
