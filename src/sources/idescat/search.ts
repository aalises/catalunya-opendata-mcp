import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import type { SourceOperationProvenance } from "../common/provenance.js";
import { IdescatError, type IdescatLanguage } from "./client.js";
import { createIdescatOperationProvenance } from "./metadata.js";
import { normalizeLimit } from "./request.js";
import type { IdescatSearchIndexEntry } from "./search-index/types.js";

export interface IdescatSearchTablesInput {
  lang?: IdescatLanguage;
  limit?: number;
  query: string;
}

export interface IdescatTableSearchCard extends IdescatSearchIndexEntry {
  geo_candidates: string[] | null;
  lang: IdescatLanguage;
  score: number;
}

export interface IdescatSearchTablesResult {
  data: {
    generated_at: string;
    index_version: string;
    lang: IdescatLanguage;
    limit: number;
    query: string;
    requested_lang: IdescatLanguage;
    results: IdescatTableSearchCard[];
    source_collection_urls: string[];
    total: number;
  };
  provenance: SourceOperationProvenance<"idescat">;
}

interface LoadedIndex {
  entries: IdescatSearchIndexEntry[];
  generatedAt: string;
  indexVersion: string;
  lang: IdescatLanguage;
  sourceCollectionUrls: string[];
}

interface SearchIndexModule {
  default: IdescatSearchIndexEntry[];
  generatedAt: string;
  indexVersion: string;
  sourceCollectionUrls: string[];
}

export async function searchIdescatTables(
  input: IdescatSearchTablesInput,
  config: AppConfig,
  options: { logger?: Logger } = {},
): Promise<IdescatSearchTablesResult> {
  const requestedLang = input.lang ?? "ca";
  const limit = normalizeLimit(input.limit, config.maxResults, 10);
  const query = input.query.trim();

  if (!query) {
    throw new IdescatError("invalid_input", "query must not be empty.");
  }

  const index = await selectIndex(requestedLang);
  const logger = options.logger ?? createLogger(config).child({ source: "idescat" });
  maybeWarnStaleIndex(index, logger);

  const rankedResults = rankIdescatSearchResults(index.entries, query);
  const ranked = rankedResults.slice(0, limit).map((result) => ({
    ...result.entry,
    geo_candidates: null,
    lang: index.lang,
    score: result.score,
  }));

  const provenance = createIdescatOperationProvenance(
    "table_search",
    index.lang,
    new URL(
      index.sourceCollectionUrls[0] ?? `https://api.idescat.cat/taules/v2?lang=${index.lang}`,
    ),
  );

  return {
    data: {
      query,
      requested_lang: requestedLang,
      lang: index.lang,
      limit,
      total: rankedResults.length,
      generated_at: index.generatedAt,
      index_version: index.indexVersion,
      source_collection_urls: index.sourceCollectionUrls,
      results: ranked,
    },
    provenance,
  };
}

export function rankIdescatSearchResults(
  entries: IdescatSearchIndexEntry[],
  query: string,
): Array<{ entry: IdescatSearchIndexEntry; score: number }> {
  const tokens = normalizeSearchTerm(query).split(" ").filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  return entries
    .map((entry) => {
      const haystack = normalizeSearchTerm(
        [entry.label, entry.ancestor_labels.statistic, entry.ancestor_labels.node].join(" "),
      );

      if (!tokens.every((token) => haystack.includes(token))) {
        return null;
      }

      const score = tokens.reduce((sum, token) => {
        if (normalizeSearchTerm(entry.label).includes(token)) {
          return sum + 5;
        }

        if (normalizeSearchTerm(entry.ancestor_labels.node).includes(token)) {
          return sum + 3;
        }

        return sum + 1;
      }, 0);

      return { entry, score };
    })
    .filter(
      (result): result is { entry: IdescatSearchIndexEntry; score: number } => result !== null,
    )
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.label.localeCompare(right.entry.label),
    );
}

export function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

async function selectIndex(lang: IdescatLanguage): Promise<LoadedIndex> {
  const index = await loadIndex(lang);

  if (index.entries.length > 0 || lang === "ca") {
    return index;
  }

  return loadIndex("ca");
}

async function loadIndex(lang: IdescatLanguage): Promise<LoadedIndex> {
  const module = await loadIndexModule(lang);

  return {
    entries: module.default,
    generatedAt: module.generatedAt,
    indexVersion: module.indexVersion,
    lang,
    sourceCollectionUrls: module.sourceCollectionUrls,
  };
}

async function loadIndexModule(lang: IdescatLanguage): Promise<SearchIndexModule> {
  switch (lang) {
    case "ca":
      return import("./search-index/ca.js");
    case "en":
      return import("./search-index/en.js");
    case "es":
      return import("./search-index/es.js");
  }
}

function maybeWarnStaleIndex(index: LoadedIndex, logger: Logger): void {
  const generatedAt = Date.parse(index.generatedAt);

  if (!Number.isFinite(generatedAt)) {
    return;
  }

  const ageMs = Date.now() - generatedAt;
  const staleMs = 365 * 24 * 60 * 60 * 1_000;

  if (ageMs > staleMs) {
    logger.warn("index_stale", {
      source: "idescat",
      generatedAt: index.generatedAt,
      lang: index.lang,
    });
  }
}
