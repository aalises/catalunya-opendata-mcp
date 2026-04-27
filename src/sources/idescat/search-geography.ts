import { normalizeSearchTerm } from "./search-normalize.js";
import { IDESCAT_PLACE_ALIASES } from "./search-places.js";

export const CANONICAL_GEO_ORDER = ["cat", "prov", "at", "com", "mun", "ac", "dis", "sec"] as const;

export interface IdescatDiscoveryQueryAnalysis {
  geoTokens: string[];
  requestedGeoIds: string[];
  topicTokens: string[];
}

interface GeoAlias {
  geoIds: string[];
  tokens: string[];
}

const GEO_ALIASES: GeoAlias[] = [
  alias("seccio censal", "sec"),
  alias("seccions censals", "sec"),
  alias("census section", "sec"),
  alias("census sections", "sec"),
  alias("agrupacio censal", "ac"),
  alias("agrupacions censals", "ac"),
  alias("census tract group", "ac"),
  alias("census tract groups", "ac"),
  alias("ambit territorial", "at"),
  alias("ambits territorials", "at"),
  alias("territorial area", "at"),
  alias("territorial areas", "at"),
  alias("comarca", "com"),
  alias("comarques", "com"),
  alias("comarcal", "com"),
  alias("comarcals", "com"),
  alias("county", "com"),
  alias("counties", "com"),
  alias("municipi", "mun"),
  alias("municipis", "mun"),
  alias("municipal", "mun"),
  alias("municipals", "mun"),
  alias("municipio", "mun"),
  alias("municipios", "mun"),
  alias("municipality", "mun"),
  alias("municipalities", "mun"),
  alias("provincia", "prov"),
  alias("provincies", "prov"),
  alias("provincial", "prov"),
  alias("provincials", "prov"),
  alias("province", "prov"),
  alias("provinces", "prov"),
  alias("catalunya", "cat"),
  alias("catalonia", "cat"),
  alias("cataluna", "cat"),
  alias("districte", "dis"),
  alias("districtes", "dis"),
  alias("district", "dis"),
  alias("districts", "dis"),
];

const DISCOVERY_ALIASES: GeoAlias[] = [...GEO_ALIASES, ...IDESCAT_PLACE_ALIASES].sort(
  (left, right) => {
    if (right.tokens.length !== left.tokens.length) {
      return right.tokens.length - left.tokens.length;
    }

    const leftText = left.tokens.join(" ");
    const rightText = right.tokens.join(" ");
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  },
);

const CANONICAL_GEO_POSITION = new Map<string, number>(
  CANONICAL_GEO_ORDER.map((geoId, index) => [geoId, index]),
);

export function analyzeIdescatDiscoveryQuery(query: string): IdescatDiscoveryQueryAnalysis {
  const tokens = normalizeSearchTerm(query).split(" ").filter(Boolean);
  const topicTokens: string[] = [];
  const geoTokens: string[] = [];
  const requestedGeoIds: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const match = DISCOVERY_ALIASES.find((candidate) => matchesAt(tokens, index, candidate.tokens));

    if (!match) {
      topicTokens.push(tokens[index] ?? "");
      index += 1;
      continue;
    }

    geoTokens.push(...match.tokens);
    for (const geoId of match.geoIds) {
      pushUnique(requestedGeoIds, geoId);
    }
    index += match.tokens.length;
  }

  return { topicTokens, requestedGeoIds, geoTokens };
}

export function orderGeoCandidates(
  available: readonly string[],
  requested: readonly string[],
): string[] {
  const availableSet = new Set(available);
  const requestedFirst = requested.filter((geoId, index) => {
    return availableSet.has(geoId) && requested.indexOf(geoId) === index;
  });
  const remaining = available
    .filter((geoId) => !requestedFirst.includes(geoId))
    .sort(compareGeoIds);

  return [...requestedFirst, ...remaining];
}

function alias(value: string, geoId: string): GeoAlias {
  return {
    geoIds: [geoId],
    tokens: normalizeSearchTerm(value).split(" ").filter(Boolean),
  };
}

function matchesAt(
  tokens: readonly string[],
  index: number,
  candidate: readonly string[],
): boolean {
  return candidate.every((token, offset) => tokens[index + offset] === token);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function compareGeoIds(left: string, right: string): number {
  const leftPosition = CANONICAL_GEO_POSITION.get(left) ?? Number.POSITIVE_INFINITY;
  const rightPosition = CANONICAL_GEO_POSITION.get(right) ?? Number.POSITIVE_INFINITY;

  if (leftPosition !== rightPosition) {
    return leftPosition - rightPosition;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}
