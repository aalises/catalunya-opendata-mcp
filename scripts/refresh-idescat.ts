#!/usr/bin/env tsx
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getUtf8ByteLength } from "../src/sources/common/caps.js";
import {
  IDESCAT_TABLES_BASE_URL,
  IDESCAT_USER_AGENT,
  type IdescatLanguage,
} from "../src/sources/idescat/client.js";
import type { IdescatSearchIndexEntry } from "../src/sources/idescat/search-index/types.js";

export const DEFAULT_REFRESH_LANGUAGES = ["ca", "es", "en"] as const satisfies IdescatLanguage[];
export const DEFAULT_PACE_MS = 250;
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SHARD_THRESHOLD_BYTES = 1_048_576;
export const INDEX_VERSION_PREFIX = "generated";

export interface IdescatGeneratedLanguageIndex {
  entries: IdescatSearchIndexEntry[];
  generatedAt: string;
  indexVersion: string;
  lang: IdescatLanguage;
  sourceCollectionUrls: string[];
}

export interface RenderedIndexFile {
  content: string;
  relativePath: string;
}

export interface RefreshIdescatOptions {
  fetchFn?: typeof fetch;
  generatedAt?: string;
  indexVersion?: string;
  languages?: readonly IdescatLanguage[];
  log?: (message: string) => void;
  maxRetries?: number;
  outputDir?: string;
  paceMs?: number;
  requestTimeoutMs?: number;
  rng?: () => number;
  shardThresholdBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Collection {
  href?: string;
  label: string;
  link: {
    item: CollectionItem[];
  };
}

interface CollectionItem {
  href: string;
  label: string;
  updated?: unknown;
}

interface CollectionFetcher {
  fetchCollection(url: URL): Promise<Collection>;
}

export async function refreshIdescatSearchIndex(
  options: RefreshIdescatOptions = {},
): Promise<IdescatGeneratedLanguageIndex[]> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const indexVersion =
    options.indexVersion ?? `${INDEX_VERSION_PREFIX}-${generatedAt.slice(0, 10)}`;
  const outputDir =
    options.outputDir ??
    fileURLToPath(new URL("../src/sources/idescat/search-index/", import.meta.url));
  const languages = options.languages ?? DEFAULT_REFRESH_LANGUAGES;
  const shardThresholdBytes = options.shardThresholdBytes ?? DEFAULT_SHARD_THRESHOLD_BYTES;
  const results: IdescatGeneratedLanguageIndex[] = [];

  for (const lang of languages) {
    options.log?.(`Refreshing IDESCAT ${lang} search index...`);
    const index = await crawlIdescatLanguageIndex(lang, {
      ...options,
      generatedAt,
      indexVersion,
    });
    await writeLanguageIndex(outputDir, index, shardThresholdBytes);
    options.log?.(`Wrote ${index.entries.length} IDESCAT ${lang} table entries.`);
    results.push(index);
  }

  return results;
}

export async function crawlIdescatLanguageIndex(
  lang: IdescatLanguage,
  options: RefreshIdescatOptions = {},
): Promise<IdescatGeneratedLanguageIndex> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const indexVersion =
    options.indexVersion ?? `${INDEX_VERSION_PREFIX}-${generatedAt.slice(0, 10)}`;
  const fetcher = createCollectionFetcher(options);
  const rootUrl = buildCollectionUrl(lang);
  const rootCollection = await fetcher.fetchCollection(rootUrl);
  const statistics = parseCollectionItems(rootCollection, rootUrl, [], 1).sort(compareItemIds);
  const entries: IdescatSearchIndexEntry[] = [];

  options.log?.(`Found ${statistics.length} IDESCAT ${lang} statistics.`);

  for (const statistic of statistics) {
    const statisticId = statistic.ids[0] ?? "";
    const nodesUrl = buildCollectionUrl(lang, statisticId);
    const nodesCollection = await fetcher.fetchCollection(nodesUrl);
    const nodes = parseCollectionItems(nodesCollection, nodesUrl, [statisticId], 2).sort(
      compareItemIds,
    );
    let statisticTableCount = 0;

    options.log?.(`Crawling ${lang}/${statisticId}: ${nodes.length} nodes...`);

    for (const node of nodes) {
      const nodeId = node.ids[1] ?? "";
      const tablesUrl = buildCollectionUrl(lang, statisticId, nodeId);
      const tablesCollection = await fetcher.fetchCollection(tablesUrl);
      const tables = parseCollectionItems(tablesCollection, tablesUrl, [statisticId, nodeId], 3)
        .map((table) => ({
          statistics_id: statisticId,
          node_id: nodeId,
          table_id: table.ids[2] ?? "",
          label: table.label,
          ancestor_labels: {
            statistic: statistic.label,
            node: node.label,
          },
          source_url: buildCollectionUrl(lang, statisticId, nodeId, table.ids[2] ?? "").toString(),
        }))
        .sort(compareEntries);

      statisticTableCount += tables.length;
      entries.push(...tables);
    }

    options.log?.(`Crawled ${lang}/${statisticId}: ${statisticTableCount} tables.`);
  }

  entries.sort(compareEntries);

  return {
    lang,
    generatedAt,
    indexVersion,
    sourceCollectionUrls: [rootUrl.toString()],
    entries,
  };
}

export function renderLanguageIndexFiles(
  index: IdescatGeneratedLanguageIndex,
  shardThresholdBytes = DEFAULT_SHARD_THRESHOLD_BYTES,
): RenderedIndexFile[] {
  const flat = renderFlatLanguageIndex(index);

  if (getUtf8ByteLength(flat) <= shardThresholdBytes) {
    return [
      {
        relativePath: `${index.lang}.ts`,
        content: flat,
      },
    ];
  }

  const grouped = groupEntriesByStatistic(index.entries);
  const files: RenderedIndexFile[] = [];
  const imports: string[] = [];
  const spreads: string[] = [];

  for (const [statisticsId, entries] of grouped) {
    const importName = toImportName(statisticsId);
    const shardContent = renderEntriesModule(entries, "../types.js");

    if (getUtf8ByteLength(shardContent) > shardThresholdBytes) {
      // TODO: a single statistic shard exceeds the threshold — extend
      // `groupEntriesByStatistic` to split further (e.g. by node_id) instead of
      // forcing the maintainer to bump IDESCAT_REFRESH_SHARD_BYTES.
      throw new Error(
        `IDESCAT ${index.lang}/${statisticsId} shard exceeds ${shardThresholdBytes} bytes.`,
      );
    }

    imports.push(`import ${importName} from "./${statisticsId}.js";`);
    spreads.push(`...${importName}`);
    files.push({
      relativePath: `${index.lang}/${statisticsId}.ts`,
      content: shardContent,
    });
  }

  files.push({
    relativePath: `${index.lang}/index.ts`,
    content: [
      'import type { IdescatSearchIndexEntry } from "../types.js";',
      ...imports,
      "",
      "// biome-ignore format: generated search-index barrel",
      `const entries: IdescatSearchIndexEntry[] = [${spreads.join(", ")}];`,
      "",
      "export default entries;",
      `export const generatedAt = ${JSON.stringify(index.generatedAt)};`,
      `export const indexVersion = ${JSON.stringify(index.indexVersion)};`,
      `export const sourceCollectionUrls = ${JSON.stringify(index.sourceCollectionUrls)};`,
      "",
    ].join("\n"),
  });
  files.push({
    relativePath: `${index.lang}.ts`,
    content: [
      `export { default, generatedAt, indexVersion, sourceCollectionUrls } from "./${index.lang}/index.js";`,
      "",
    ].join("\n"),
  });

  return files.sort((left, right) => compareCodePoints(left.relativePath, right.relativePath));
}

function createCollectionFetcher(options: RefreshIdescatOptions): CollectionFetcher {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const rng = options.rng ?? Math.random;
  let hasRequested = false;

  return {
    async fetchCollection(url) {
      // Pace once between distinct fetchCollection calls — retry backoff is
      // separate so a failed request doesn't get double-delayed (paceMs + backoff).
      if (hasRequested && paceMs > 0) {
        await sleep(paceMs);
      }
      hasRequested = true;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const response = await fetchFn(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": IDESCAT_USER_AGENT,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        }).catch((error: unknown) => {
          if (attempt === maxRetries) {
            throw error;
          }

          return null;
        });

        if (response?.ok) {
          return parseCollection(await response.json(), url);
        }

        if (response && (!shouldRetryStatus(response.status) || attempt === maxRetries)) {
          throw new Error(
            `IDESCAT collection request failed with HTTP ${response.status} ${response.statusText}: ${url.toString()}`,
          );
        }

        await sleep(getRetryDelayMs(attempt, rng));
      }

      throw new Error(`IDESCAT collection request failed: ${url.toString()}`);
    },
  };
}

function parseCollection(raw: unknown, url: URL): Collection {
  if (!isRecord(raw)) {
    throw new Error(`IDESCAT collection is not an object: ${url.toString()}`);
  }

  if (raw.class !== "collection" || typeof raw.label !== "string") {
    throw new Error(`IDESCAT response is not a collection: ${url.toString()}`);
  }

  const link = isRecord(raw.link) ? raw.link : undefined;
  const item = Array.isArray(link?.item) ? link.item : undefined;

  if (!item) {
    throw new Error(`IDESCAT collection is missing link.item: ${url.toString()}`);
  }

  return {
    label: raw.label,
    ...(typeof raw.href === "string" ? { href: raw.href } : {}),
    link: {
      item: item.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.href !== "string" || typeof entry.label !== "string") {
          return [];
        }

        return [
          {
            href: entry.href,
            label: entry.label,
            ...(entry.updated === undefined ? {} : { updated: entry.updated }),
          },
        ];
      }),
    },
  };
}

function parseCollectionItems(
  collection: Collection,
  requestUrl: URL,
  parentSegments: string[],
  expectedLength: number,
): Array<{ ids: string[]; label: string }> {
  const collectionBase = resolveCollectionBase(collection.href, requestUrl);

  return collection.link.item.map((item) => ({
    ids: parseCollectionHref(item.href, collectionBase, parentSegments, expectedLength),
    label: item.label,
  }));
}

function parseCollectionHref(
  href: string,
  collectionBase: URL,
  parentSegments: string[],
  expectedLength: number,
): string[] {
  const url = new URL(href, collectionBase);
  const path = url.pathname.replace(/\/+$/u, "");
  const marker = "/taules/v2/";
  const start = path.indexOf(marker);

  if (start < 0) {
    throw new Error(`IDESCAT collection item href is outside Tables v2: ${href}`);
  }

  const segments = path
    .slice(start + marker.length)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (segments.length !== expectedLength) {
    throw new Error(`IDESCAT collection item href has unexpected depth: ${href}`);
  }

  if (!parentSegments.every((segment, index) => segments[index] === segment)) {
    throw new Error(`IDESCAT collection item href does not match parent: ${href}`);
  }

  return segments;
}

function resolveCollectionBase(collectionHref: string | undefined, requestUrl: URL): URL {
  const candidate = collectionHref ?? requestUrl.toString();
  const url = new URL(candidate);

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

function buildCollectionUrl(lang: IdescatLanguage, ...segments: string[]): URL {
  const url = new URL(
    segments.length > 0
      ? `${IDESCAT_TABLES_BASE_URL}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`
      : IDESCAT_TABLES_BASE_URL,
  );
  url.searchParams.set("lang", lang);
  return url;
}

function renderFlatLanguageIndex(index: IdescatGeneratedLanguageIndex): string {
  return [
    renderEntriesModule(index.entries, "./types.js").trimEnd(),
    `export const generatedAt = ${JSON.stringify(index.generatedAt)};`,
    `export const indexVersion = ${JSON.stringify(index.indexVersion)};`,
    `export const sourceCollectionUrls = ${JSON.stringify(index.sourceCollectionUrls)};`,
    "",
  ].join("\n");
}

function renderEntriesModule(entries: IdescatSearchIndexEntry[], typeImport: string): string {
  return [
    `import type { IdescatSearchIndexEntry } from ${JSON.stringify(typeImport)};`,
    "",
    "// biome-ignore format: generated search-index entries",
    `const entries: IdescatSearchIndexEntry[] = ${JSON.stringify(entries, null, 2)};`,
    "",
    "export default entries;",
    "",
  ].join("\n");
}

function groupEntriesByStatistic(
  entries: IdescatSearchIndexEntry[],
): Array<[string, IdescatSearchIndexEntry[]]> {
  const grouped = new Map<string, IdescatSearchIndexEntry[]>();

  for (const entry of entries) {
    const existing = grouped.get(entry.statistics_id) ?? [];
    existing.push(entry);
    grouped.set(entry.statistics_id, existing);
  }

  return [...grouped.entries()].sort(([left], [right]) => compareCodePoints(left, right));
}

async function writeLanguageIndex(
  outputDir: string,
  index: IdescatGeneratedLanguageIndex,
  shardThresholdBytes: number,
): Promise<void> {
  const files = renderLanguageIndexFiles(index, shardThresholdBytes);
  // refresh:idescat is a single-runner manual maintainer command, so a coarse
  // millisecond timestamp is enough to avoid stale-temp collisions in practice.
  const tempDir = path.join(outputDir, `.tmp-${index.lang}-${Date.now()}`);

  await mkdir(tempDir, { recursive: true });

  try {
    for (const file of files) {
      const target = path.join(tempDir, file.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }

    await rm(path.join(outputDir, `${index.lang}.ts`), { force: true });
    await rm(path.join(outputDir, index.lang), { force: true, recursive: true });

    for (const file of files) {
      const source = path.join(tempDir, file.relativePath);
      const target = path.join(outputDir, file.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

// Code-point order keeps the generated index stable across maintainer locales —
// localeCompare would let two machines produce reordered files for the same data.
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareItemIds(
  left: { ids: string[]; label: string },
  right: { ids: string[]; label: string },
): number {
  return (
    compareCodePoints(left.ids.join("/"), right.ids.join("/")) ||
    compareCodePoints(left.label, right.label)
  );
}

function compareEntries(left: IdescatSearchIndexEntry, right: IdescatSearchIndexEntry): number {
  return (
    compareCodePoints(left.statistics_id, right.statistics_id) ||
    compareCodePoints(left.node_id, right.node_id) ||
    compareCodePoints(left.table_id, right.table_id)
  );
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function getRetryDelayMs(attempt: number, rng: () => number): number {
  return 250 * 2 ** attempt + Math.floor(rng() * 100);
}

function toImportName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_$]/gu, "_");
  return `entries_${sanitized || "index"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLanguages(value: string | undefined): IdescatLanguage[] {
  if (!value?.trim()) {
    return [...DEFAULT_REFRESH_LANGUAGES];
  }

  return value.split(",").map((item) => {
    const lang = item.trim();

    if (lang !== "ca" && lang !== "es" && lang !== "en") {
      throw new Error(`Unsupported IDESCAT language: ${lang}`);
    }

    return lang;
  });
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }

  return parsed;
}

function isMain(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain()) {
  await refreshIdescatSearchIndex({
    languages: parseLanguages(process.env.IDESCAT_REFRESH_LANGS),
    log: (message) => console.log(message),
    paceMs: parseNumberEnv(process.env.IDESCAT_REFRESH_PACE_MS, DEFAULT_PACE_MS),
    requestTimeoutMs: parseNumberEnv(
      process.env.IDESCAT_REFRESH_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    shardThresholdBytes: parseNumberEnv(
      process.env.IDESCAT_REFRESH_SHARD_BYTES,
      DEFAULT_SHARD_THRESHOLD_BYTES,
    ),
  });
}
