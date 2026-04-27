import type { AppConfig } from "../../config.js";
import { createLogger, type Logger } from "../../logger.js";
import type { SourceOperationProvenance } from "../common/provenance.js";
import { IdescatError, type IdescatLanguage } from "./client.js";
import { createIdescatOperationProvenance } from "./metadata.js";
import { normalizeLimit } from "./request.js";
import {
  analyzeIdescatDiscoveryQuery,
  type IdescatDiscoveryQueryAnalysis,
  orderGeoCandidates,
} from "./search-geography.js";
import type { IdescatSearchIndexEntry } from "./search-index/types.js";
import { normalizeSearchTerm } from "./search-normalize.js";
import {
  CANONICAL_STATISTIC_PRIORITY,
  GEO_MATCH_BOOST,
  PRIORITY_BOOST_FACTOR,
  STOP_TOKENS,
} from "./search-priority.js";
import { buildIdescatSemanticTopicGroups } from "./search-semantics.js";

export { normalizeSearchTerm } from "./search-normalize.js";

export interface IdescatSearchTablesInput {
  lang?: IdescatLanguage;
  limit?: number;
  query: string;
}

export type IdescatTableSearchCard = Omit<IdescatSearchIndexEntry, "geo_ids"> & {
  geo_candidates: string[] | null;
  lang: IdescatLanguage;
  score: number;
};

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
  geoMatchCount: number;
  openSeries: boolean;
  priority: number;
  score: number;
}

type MatchQuality = "id" | "word" | "substring";

const SEMANTIC_ALIAS_MATCH_BONUS = 2;

interface SemanticGroupMatch {
  qualities: MatchQuality[];
  score: number;
  substringCount: number;
  tokens: string[];
  strongCount: number;
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

  const queryAnalysis = analyzeIdescatDiscoveryQuery(query);
  const rankedResults = rankIdescatSearchResults(index.entries, query, queryAnalysis);
  const ranked = rankedResults.slice(0, limit).map((result) => {
    const { geo_ids: geoIds, ...publicEntry } = result.entry;
    return {
      ...publicEntry,
      geo_candidates: geoIds?.length
        ? orderGeoCandidates(geoIds, queryAnalysis.requestedGeoIds)
        : null,
      lang: index.lang,
      score: result.score,
    };
  });

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
  analysis: IdescatDiscoveryQueryAnalysis = analyzeIdescatDiscoveryQuery(query),
): Array<{ entry: IdescatSearchIndexEntry; score: number }> {
  const topicTokens = stripTemporalSearchTokens(analysis.topicTokens);
  const semanticGroups = buildIdescatSemanticTopicGroups(topicTokens);

  if (semanticGroups.length === 0) {
    return [];
  }

  return entries
    .map((entry): RankCandidate | null => {
      const normLabel = normalizeSearchTerm(entry.label);
      const normNode = normalizeSearchTerm(entry.ancestor_labels.node);
      const normStat = normalizeSearchTerm(entry.ancestor_labels.statistic);
      const normHaystack = [normLabel, normStat, normNode].join(" ");
      const haystackTokens = normHaystack.split(" ");

      const matchQuality = (token: string): MatchQuality | null => {
        if (token === entry.statistics_id.toLowerCase()) {
          return "id";
        }

        if (token === entry.table_id || token === entry.node_id) {
          return "id";
        }

        if (haystackTokens.includes(token)) {
          return "word";
        }

        if (token.length <= 2) {
          return null;
        }

        return hasPrefixSubstringMatch(haystackTokens, token) ? "substring" : null;
      };

      const scoreToken = (token: string): number => {
        if (normLabel.includes(token)) {
          return 5;
        }

        if (normNode.includes(token)) {
          return 3;
        }

        if (normStat.includes(token)) {
          return 1;
        }

        return token === entry.statistics_id.toLowerCase() ||
          token === entry.table_id ||
          token === entry.node_id
          ? 5
          : 1;
      };

      const groupMatches = semanticGroups.map((group): SemanticGroupMatch | null => {
        let bestMatch: SemanticGroupMatch | null = null;

        for (const alternative of group.alternatives) {
          const qualities = alternative.tokens.map(matchQuality);

          if (qualities.some((quality) => quality === null)) {
            continue;
          }

          const strongCount = qualities.filter(
            (quality) => quality === "id" || quality === "word",
          ).length;
          const substringCount = qualities.length - strongCount;
          const candidate: SemanticGroupMatch = {
            qualities: qualities as MatchQuality[],
            score:
              alternative.tokens.reduce((sum, token) => sum + scoreToken(token), 0) +
              (alternative.semantic ? SEMANTIC_ALIAS_MATCH_BONUS : 0),
            strongCount,
            substringCount,
            tokens: alternative.tokens,
          };

          if (bestMatch === null || compareSemanticGroupMatches(candidate, bestMatch) < 0) {
            bestMatch = candidate;
          }
        }

        return bestMatch;
      });

      if (groupMatches.some((match) => match === null)) {
        return null;
      }

      const priority = CANONICAL_STATISTIC_PRIORITY.get(entry.statistics_id) ?? 0;
      const matchedGroups = groupMatches as SemanticGroupMatch[];
      const matchedTokens = matchedGroups.flatMap((match) => match.tokens);
      const matchQualities = matchedGroups.flatMap((match) => match.qualities);
      const phraseTokens = stripStop(matchedTokens);
      const phrase = phraseTokens.join(" ");
      let score = matchedGroups.reduce((sum, match) => sum + match.score, 0);

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

      if (matchedTokens.length >= 2 && matchedTokens.every((token) => normLabel.includes(token))) {
        score += 4;
      }

      if (
        matchedTokens.some(
          (token) => token.length >= 3 && token === entry.statistics_id.toLowerCase(),
        )
      ) {
        score += 20;
      }

      if (matchedTokens.length >= 2 && matchedTokens.every((token) => normStat.includes(token))) {
        score += 6;
      }

      score += priority * PRIORITY_BOOST_FACTOR;

      const geoMatchCount = getGeoMatchCount(entry.geo_ids ?? [], analysis.requestedGeoIds);
      const shouldBoostGeo =
        analysis.requestedGeoIds.length > 0 &&
        geoMatchCount > 0 &&
        matchQualities.every((quality) => quality === "id" || quality === "word");

      if (shouldBoostGeo) {
        score += geoMatchCount * GEO_MATCH_BOOST;
      }

      const firstPosRaw = normLabel.indexOf(matchedTokens[0] ?? "");
      const firstPos = firstPosRaw === -1 ? Number.POSITIVE_INFINITY : firstPosRaw;

      return {
        entry,
        firstPos,
        geoMatchCount,
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

      if (right.geoMatchCount !== left.geoMatchCount) {
        return right.geoMatchCount - left.geoMatchCount;
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

function stripStop(tokens: readonly string[]): string[] {
  return tokens.filter((token) => token.length > 0 && !STOP_TOKENS.has(token));
}

const TEMPORAL_YEAR_TOKEN_REGEX = /^(?:18|19|20)\d{2}$/u;

const TEMPORAL_PHRASES: readonly (readonly string[])[] = [
  ["most", "recent"],
  ["last", "year"],
  ["latest", "year"],
  ["ultim", "any"],
  ["darrer", "any"],
  ["ultim", "periode"],
  ["darrer", "periode"],
  ["ultimo", "ano"],
  ["ultimo", "periodo"],
  ["serie", "historica"],
  ["series", "historicas"],
  ["historical", "series"],
  ["time", "series"],
  ["latest"],
];

function stripTemporalSearchTokens(tokens: readonly string[]): string[] {
  const stripped: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const phrase = TEMPORAL_PHRASES.find((candidate) => matchesAt(tokens, index, candidate));

    if (phrase !== undefined) {
      index += phrase.length;
      continue;
    }

    const token = tokens[index] ?? "";

    if (TEMPORAL_YEAR_TOKEN_REGEX.test(token)) {
      index += 1;
      continue;
    }

    stripped.push(token);
    index += 1;
  }

  return stripped;
}

function hasPrefixSubstringMatch(haystackTokens: readonly string[], token: string): boolean {
  return haystackTokens.some((haystackToken) => {
    return haystackToken.length > token.length && haystackToken.startsWith(token);
  });
}

function matchesAt(
  tokens: readonly string[],
  index: number,
  candidate: readonly string[],
): boolean {
  return candidate.every((token, offset) => tokens[index + offset] === token);
}

function compareSemanticGroupMatches(left: SemanticGroupMatch, right: SemanticGroupMatch): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if (right.strongCount !== left.strongCount) {
    return right.strongCount - left.strongCount;
  }

  if (left.substringCount !== right.substringCount) {
    return left.substringCount - right.substringCount;
  }

  if (right.tokens.length !== left.tokens.length) {
    return right.tokens.length - left.tokens.length;
  }

  return left.tokens.join(" ").localeCompare(right.tokens.join(" "));
}

function buildPhraseHaystack(text: string): string {
  return stripStop(normalizeSearchTerm(text).split(" ")).join(" ");
}

function getGeoMatchCount(available: readonly string[], requested: readonly string[]): number {
  const availableSet = new Set(available);
  return requested.filter((geoId) => availableSet.has(geoId)).length;
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
