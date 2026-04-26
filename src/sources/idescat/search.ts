import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import type { SourceOperationProvenance } from "../common/provenance.js";
import { IdescatError, type IdescatLanguage } from "./client.js";
import { createIdescatOperationProvenance } from "./metadata.js";
import { normalizeLimit } from "./request.js";
import type { IdescatSearchIndexEntry } from "./search-index/types.js";
import {
  CANONICAL_STATISTIC_PRIORITY,
  PRIORITY_BOOST_FACTOR,
  STOP_TOKENS,
} from "./search-priority.js";

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

interface RankCandidate {
  entry: IdescatSearchIndexEntry;
  firstPos: number;
  openSeries: boolean;
  priority: number;
  score: number;
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

  const phraseTokens = stripStop(tokens);
  const phrase = phraseTokens.join(" ");

  return entries
    .map((entry): RankCandidate | null => {
      const normLabel = normalizeSearchTerm(entry.label);
      const normNode = normalizeSearchTerm(entry.ancestor_labels.node);
      const normStat = normalizeSearchTerm(entry.ancestor_labels.statistic);
      const normHaystack = [normLabel, normStat, normNode].join(" ");
      const haystackTokens = normHaystack.split(" ");

      const tokenSatisfied = (token: string): boolean => {
        if (token === entry.statistics_id.toLowerCase()) {
          return true;
        }

        if (token === entry.table_id || token === entry.node_id) {
          return true;
        }

        if (token.length <= 2) {
          return haystackTokens.includes(token);
        }

        return normHaystack.includes(token);
      };

      if (!tokens.every(tokenSatisfied)) {
        return null;
      }

      const priority = CANONICAL_STATISTIC_PRIORITY.get(entry.statistics_id) ?? 0;
      let score = tokens.reduce((sum, token) => {
        if (normLabel.includes(token)) {
          return sum + 5;
        }

        if (normNode.includes(token)) {
          return sum + 3;
        }

        if (normStat.includes(token)) {
          return sum + 1;
        }

        return token === entry.statistics_id.toLowerCase() ||
          token === entry.table_id ||
          token === entry.node_id
          ? sum + 5
          : sum + 1;
      }, 0);

      const phraseLabel = buildPhraseHaystack(entry.label);
      const phraseNode = buildPhraseHaystack(entry.ancestor_labels.node);

      if (phraseTokens.length >= 2) {
        if (phraseLabel.includes(phrase)) {
          score += 15;
        }

        if (phraseNode.includes(phrase)) {
          score += 8;
        }

        for (let index = 0; index < phraseTokens.length - 1; index += 1) {
          const pair = `${phraseTokens[index]} ${phraseTokens[index + 1]}`;

          if (phraseLabel.includes(pair)) {
            score += 3;
          }

          if (phraseNode.includes(pair)) {
            score += 2;
          }
        }
      }

      if (tokens.length >= 2 && tokens.every((token) => normLabel.includes(token))) {
        score += 4;
      }

      if (
        tokens.some((token) => token.length >= 3 && token === entry.statistics_id.toLowerCase())
      ) {
        score += 20;
      }

      if (tokens.length >= 2 && tokens.every((token) => normStat.includes(token))) {
        score += 6;
      }

      score += priority * PRIORITY_BOOST_FACTOR;

      const firstPosRaw = normLabel.indexOf(tokens[0] ?? "");
      const firstPos = firstPosRaw === -1 ? Number.POSITIVE_INFINITY : firstPosRaw;

      return {
        entry,
        firstPos,
        openSeries: isOpenEndedSeries(entry.label),
        priority,
        score,
      };
    })
    .filter((result): result is RankCandidate => result !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }

      if (
        left.entry.statistics_id === right.entry.statistics_id &&
        left.openSeries !== right.openSeries
      ) {
        return left.openSeries ? -1 : 1;
      }

      if (left.firstPos !== right.firstPos) {
        return left.firstPos - right.firstPos;
      }

      return left.entry.label.localeCompare(right.entry.label);
    })
    .map(({ entry, score }) => ({ entry, score }));
}

export function normalizeSearchTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripStop(tokens: readonly string[]): string[] {
  return tokens.filter((token) => token.length > 0 && !STOP_TOKENS.has(token));
}

function buildPhraseHaystack(text: string): string {
  return stripStop(normalizeSearchTerm(text).split(" ")).join(" ");
}

const OPEN_SERIES_LABEL_REGEX = /\(\d{4}\s*[–-]\s*\)/u;

function isOpenEndedSeries(rawLabel: string): boolean {
  return OPEN_SERIES_LABEL_REGEX.test(rawLabel);
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
