import { normalizeSearchTerm } from "./search-normalize.js";
import { STOP_TOKENS } from "./search-priority.js";

export interface IdescatSemanticAlternative {
  semantic: boolean;
  tokens: string[];
}

export interface IdescatSemanticTopicGroup {
  alternatives: IdescatSemanticAlternative[];
  originalTokens: string[];
}

interface SemanticPhraseAlias {
  alternatives: string[];
  tokens: string[];
}

const PHRASE_ALIASES: SemanticPhraseAlias[] = [
  ...phraseAlias(
    [
      "taxa atur",
      "taxa d atur",
      "taxes atur",
      "taxes d atur",
      "tasa paro",
      "tasa de paro",
      "tasas paro",
      "tasas de paro",
      "unemployment rate",
      "unemployment rates",
    ],
    [
      "taxes atur",
      "taxes d atur",
      "tasas paro",
      "tasas de paro",
      "unemployment rates",
      "atur",
      "paro",
      "unemployment",
    ],
  ),
  ...phraseAlias(
    [
      "renda per capita",
      "renda per habitant",
      "renta per capita",
      "renta por habitante",
      "income per capita",
      "income per inhabitant",
    ],
    [
      "rfdb habitant",
      "rfdb inhabitant",
      "rfdb per habitant",
      "rfdb per inhabitant",
      "renda habitant",
      "renta habitante",
      "income per capita",
      "income per inhabitant",
    ],
  ),
  ...phraseAlias(
    [
      "renda familiar",
      "renda de la familia",
      "renda de la llar",
      "renda disponible",
      "renta familiar",
      "renta de la familia",
      "renta disponible",
      "family income",
      "household income",
      "income of household",
      "gross disposable household income",
    ],
    [
      "renda familiar",
      "renda disponible",
      "renta familiar",
      "renta disponible",
      "family income",
      "household income",
      "gross disposable household income",
      "rfdb",
    ],
  ),
].sort(comparePhraseAliases);

// Alias targets intentionally mix CA/ES/EN so the same user phrasing can
// recover the right statistic even when a different index language is selected.
const UNEMPLOYMENT_ALIASES = normalizeAliases([
  "atur",
  "paro",
  "desocupacio",
  "desempleo",
  "unemployment",
]);
const INCOME_ALIASES = normalizeAliases(["renda", "renta", "income", "rfdb"]);

const TOKEN_ALIASES: ReadonlyMap<string, string[]> = new Map<string, string[]>([
  ["atur", UNEMPLOYMENT_ALIASES],
  ["paro", UNEMPLOYMENT_ALIASES],
  ["desocupacio", UNEMPLOYMENT_ALIASES],
  ["desempleo", UNEMPLOYMENT_ALIASES],
  ["unemployment", UNEMPLOYMENT_ALIASES],
  ["renda", INCOME_ALIASES],
  ["renta", INCOME_ALIASES],
  ["income", INCOME_ALIASES],
  ["rfdb", INCOME_ALIASES],
]);

export function buildIdescatSemanticTopicGroups(
  topicTokens: readonly string[],
): IdescatSemanticTopicGroup[] {
  const groups: IdescatSemanticTopicGroup[] = [];

  for (let index = 0; index < topicTokens.length; ) {
    const phraseMatch = PHRASE_ALIASES.find((candidate) =>
      matchesAt(topicTokens, index, candidate.tokens),
    );

    if (phraseMatch) {
      groups.push(
        buildGroup(topicTokens.slice(index, index + phraseMatch.tokens.length), [
          phraseMatch.tokens,
          ...phraseMatch.alternatives.map(tokenize),
        ]),
      );
      index += phraseMatch.tokens.length;
      continue;
    }

    const token = topicTokens[index] ?? "";
    index += 1;

    if (!token || STOP_TOKENS.has(token)) {
      continue;
    }

    const alternatives = TOKEN_ALIASES.get(token);
    groups.push(buildGroup([token], [[token], ...(alternatives ?? []).map(tokenize)]));
  }

  return groups;
}

function buildGroup(
  originalTokens: readonly string[],
  alternatives: readonly (readonly string[])[],
): IdescatSemanticTopicGroup {
  const normalizedOriginal = originalTokens.map(normalizeSearchTerm).filter(Boolean);
  const originalKey = normalizedOriginal.join(" ");
  const seen = new Set<string>();
  const normalizedAlternatives: IdescatSemanticAlternative[] = [];

  for (const alternative of alternatives) {
    const tokens = alternative.map(normalizeSearchTerm).filter(Boolean);
    const key = tokens.join(" ");

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedAlternatives.push({
      semantic: key !== originalKey,
      tokens,
    });
  }

  return {
    alternatives: normalizedAlternatives,
    originalTokens: normalizedOriginal,
  };
}

function phraseAlias(
  triggers: readonly string[],
  alternatives: readonly string[],
): SemanticPhraseAlias[] {
  const normalizedAlternatives = normalizeAliases(alternatives);

  return triggers.map((trigger) => ({
    alternatives: normalizedAlternatives,
    tokens: tokenize(trigger),
  }));
}

function normalizeAliases(values: readonly string[]): string[] {
  return values.map((value) => tokenize(value).join(" ")).filter(Boolean);
}

function tokenize(value: string): string[] {
  return normalizeSearchTerm(value).split(" ").filter(Boolean);
}

function matchesAt(
  tokens: readonly string[],
  index: number,
  candidate: readonly string[],
): boolean {
  return candidate.every((token, offset) => tokens[index + offset] === token);
}

function comparePhraseAliases(left: SemanticPhraseAlias, right: SemanticPhraseAlias): number {
  if (right.tokens.length !== left.tokens.length) {
    return right.tokens.length - left.tokens.length;
  }

  const leftText = left.tokens.join(" ");
  const rightText = right.tokens.join(" ");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
