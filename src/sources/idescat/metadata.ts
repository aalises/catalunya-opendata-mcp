import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { SourceDatasetProvenance, SourceOperationProvenance } from "../common/provenance.js";
import { formatZodError } from "../common/zod.js";
import {
  type FetchIdescatJsonOptions,
  fetchIdescatJson,
  IDESCAT_TABLES_BASE_URL,
  IdescatError,
  type IdescatLanguage,
} from "./client.js";
import { buildIdescatUrl, safePathSegment } from "./request.js";
import { normalizeSearchTerm } from "./search-normalize.js";
import { findIdescatPlaceAliasesInText } from "./search-places.js";

export type IdescatOperationProvenance = SourceOperationProvenance<"idescat">;
export type IdescatDatasetProvenance = SourceDatasetProvenance<"idescat">;

export interface IdescatTableTupleInput {
  geo_id: string;
  lang?: IdescatLanguage;
  node_id: string;
  statistics_id: string;
  table_id: string;
}

export interface IdescatTableMetadataInput extends IdescatTableTupleInput {
  place_query?: string;
}

export interface IdescatUnit {
  decimals?: number;
  symbol?: string;
}

export interface IdescatDimensionCategory {
  id: string;
  index: number;
  label: string;
  parent?: string;
  status?: string;
  unit?: IdescatUnit;
}

export interface IdescatMetadataLink {
  class?: string;
  extension?: Record<string, unknown>;
  href: string;
  label?: string;
  rel: string;
  type?: string;
}

export interface IdescatDimensionMetadata {
  breaks?: Array<{ id: string; label: string; raw?: Record<string, unknown>; time: string }>;
  categories: IdescatDimensionCategory[];
  categories_omitted?: boolean;
  extensions?: Record<string, unknown>;
  id: string;
  label: string;
  role?: "geo" | "metric" | "time";
  size: number;
  status?: Record<string, string>;
  unit?: IdescatUnit;
}

export interface IdescatMetadataDegradation {
  dimension_ids?: string[];
  dropped: Array<"categories_for_dimensions" | "extensions" | "links" | "notes">;
  hint: string;
}

export type IdescatRecommendedFilters = Record<string, string | string[]>;

export interface IdescatFilterGuidancePlaceMatch {
  category_id: string;
  category_label: string;
  dimension_id: string;
  dimension_label: string;
}

export interface IdescatFilterGuidanceNeedsFilterDimension {
  candidates: Array<{ id: string; label: string }>;
  id: string;
  label: string;
  role?: "geo" | "metric" | "time";
  size: number;
}

export interface IdescatFilterGuidance {
  latest?: {
    last: 1;
    time_dimension_ids: string[];
  };
  needs_filter_dimensions?: IdescatFilterGuidanceNeedsFilterDimension[];
  place_matches?: IdescatFilterGuidancePlaceMatch[];
  recommended_data_call?: {
    filters?: IdescatRecommendedFilters;
    last?: 1;
    limit: 20;
  };
  recommended_filters?: IdescatRecommendedFilters;
  unresolved_place_terms?: string[];
}

export interface IdescatTableMetadata {
  alternate_geographies?: IdescatMetadataLink[];
  correction_links?: IdescatMetadataLink[];
  degradation?: IdescatMetadataDegradation;
  description?: string;
  dimensions: IdescatDimensionMetadata[];
  filter_guidance?: IdescatFilterGuidance;
  extensions?: Record<string, unknown>;
  geo_id: string;
  lang: IdescatLanguage;
  last_updated?: string;
  links?: IdescatMetadataLink[];
  node_id: string;
  notes?: string[];
  provenance: IdescatDatasetProvenance;
  related_tables?: IdescatMetadataLink[];
  statistical_sources?: string[];
  statistics_id: string;
  status_labels?: Record<string, { label: string; raw?: Record<string, unknown> }>;
  table_id: string;
  terms_url?: string;
  title: string;
  units?: {
    by_dimension?: Record<string, Record<string, IdescatUnit>>;
    default?: IdescatUnit;
  } | null;
}

export interface IdescatTableMetadataResult {
  data: IdescatTableMetadata;
  provenance: IdescatOperationProvenance;
}

const jsonStatDatasetSchema = z
  .object({
    class: z.literal("dataset"),
    dimension: z.record(z.unknown()),
    href: z.string().url().optional(),
    id: z.array(z.string()),
    label: z.string(),
    link: z.record(z.unknown()).optional(),
    note: z.array(z.string()).optional(),
    size: z.array(z.number().int().nonnegative()),
    source: z.string().optional(),
    updated: z.string().optional(),
    extension: z.record(z.unknown()).optional(),
  })
  .passthrough();

type JsonStatDataset = z.infer<typeof jsonStatDatasetSchema>;

interface NormalizedIdescatTableMetadataInput extends Required<IdescatTableTupleInput> {
  place_query?: string;
}

export async function getIdescatTableMetadata(
  input: IdescatTableMetadataInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatTableMetadataResult> {
  const normalizedInput = normalizeMetadataInput(input);
  const url = buildIdescatUrl(normalizedInput);
  const raw = await fetchIdescatJson({ url }, config, options);
  const metadata = parseIdescatTableMetadata(raw, normalizedInput, url);

  return {
    data: metadata,
    provenance: createIdescatOperationProvenance("table_metadata", normalizedInput.lang, url),
  };
}

export function parseIdescatTableMetadata(
  raw: unknown,
  input: NormalizedIdescatTableMetadataInput,
  requestUrl: URL,
): IdescatTableMetadata {
  const parsed = jsonStatDatasetSchema.safeParse(raw);

  if (!parsed.success) {
    throw new IdescatError(
      "invalid_response",
      `Invalid IDESCAT metadata response: ${formatZodError(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }

  return toTableMetadata(parsed.data, input, requestUrl);
}

export function normalizeMetadataInput(
  input: IdescatTableMetadataInput,
): NormalizedIdescatTableMetadataInput {
  return {
    geo_id: safePathSegment("geo_id", input.geo_id),
    lang: input.lang ?? "ca",
    node_id: safePathSegment("node_id", input.node_id),
    statistics_id: safePathSegment("statistics_id", input.statistics_id),
    table_id: safePathSegment("table_id", input.table_id),
    ...(input.place_query?.trim() ? { place_query: input.place_query.trim() } : {}),
  };
}

export function createIdescatOperationProvenance(
  operation: string,
  lang: IdescatLanguage = "ca",
  sourceUrl = new URL(`${IDESCAT_TABLES_BASE_URL}?lang=${lang}`),
): IdescatOperationProvenance {
  return {
    source: "idescat",
    source_url: sourceUrl.toString(),
    id: `idescat:tables:${operation}`,
    last_updated: null,
    license_or_terms: null,
    language: lang,
  };
}

function toTableMetadata(
  dataset: JsonStatDataset,
  input: NormalizedIdescatTableMetadataInput,
  requestUrl: URL,
): IdescatTableMetadata {
  const dimensions = dataset.id.map((dimensionId, index) =>
    toDimensionMetadata({
      dimensionId,
      rawDimension: dataset.dimension[dimensionId],
      role: getDimensionRole(dataset, dimensionId),
      size: dataset.size[index] ?? 0,
    }),
  );
  const links = flattenLinks(dataset.link);
  const statusLabels = parseStatusLabels(dataset.extension?.status);
  const statisticalSources =
    parseStringArray(dataset.extension?.source) ?? parseStringArray(dataset.source);
  const units = buildUnits(dimensions);
  // Resolve terms link from the dataset's link relations — do NOT fabricate
  // a terms string when the upstream payload does not surface one.
  const termsUrl = findTermsUrl(links);
  const filterGuidance = buildFilterGuidance(dimensions, input.place_query);

  return {
    ...input,
    title: dataset.label,
    dimensions,
    ...(filterGuidance ? { filter_guidance: filterGuidance } : {}),
    ...(dataset.note ? { notes: dataset.note } : {}),
    ...(statisticalSources ? { statistical_sources: statisticalSources } : {}),
    ...(units ? { units } : {}),
    ...(Object.keys(statusLabels).length > 0 ? { status_labels: statusLabels } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...getConvenienceLinks(links, input, requestUrl),
    last_updated: dataset.updated,
    ...(termsUrl ? { terms_url: termsUrl } : {}),
    extensions: omitKeys(dataset.extension, ["source", "status"]),
    provenance: {
      source: "idescat",
      source_url: requestUrl.toString(),
      id: `${input.statistics_id}/${input.node_id}/${input.table_id}/${input.geo_id}`,
      last_updated: dataset.updated ?? null,
      // license_or_terms reflects only what the upstream surfaced; null when
      // the dataset has no API-terms link (consumers can fall back to terms_url).
      license_or_terms: termsUrl ?? null,
      language: input.lang,
    },
  };
}

function findTermsUrl(links: IdescatMetadataLink[]): string | undefined {
  // IDESCAT exposes API terms via link relations like `license`, `terms`, or
  // `tos`. Match any of those rels case-insensitively without inventing terms
  // when none exists.
  const termsRels = new Set(["license", "terms", "terms-of-service", "tos"]);
  return links.find((link) => termsRels.has(link.rel.toLowerCase()))?.href;
}

function buildFilterGuidance(
  dimensions: IdescatDimensionMetadata[],
  placeQuery?: string,
): IdescatFilterGuidance | undefined {
  const recommendedFilters: IdescatRecommendedFilters = {};
  const placeMatches = findPlaceMatches(dimensions, placeQuery);
  const needsFilterDimensions: IdescatFilterGuidanceNeedsFilterDimension[] = [];

  for (const [dimensionId, matches] of groupPlaceMatches(placeMatches)) {
    recommendedFilters[dimensionId] =
      matches.length === 1
        ? (matches[0]?.category_id ?? "")
        : matches.map((match) => match.category_id);
  }

  for (const dimension of dimensions) {
    if (dimension.role === "time" || recommendedFilters[dimension.id] !== undefined) {
      continue;
    }

    const safeDefault = getSafeDefaultCategory(dimension);

    if (safeDefault) {
      recommendedFilters[dimension.id] = safeDefault.id;
      continue;
    }

    if (dimension.categories.length > 1) {
      needsFilterDimensions.push({
        id: dimension.id,
        label: dimension.label,
        ...(dimension.role ? { role: dimension.role } : {}),
        size: dimension.size,
        candidates: dimension.categories.slice(0, 5).map((category) => ({
          id: category.id,
          label: category.label,
        })),
      });
    }
  }

  const timeDimensionIds = dimensions
    .filter((dimension) => dimension.role === "time")
    .map((dimension) => dimension.id);
  const hasRecommendedFilters = Object.keys(recommendedFilters).length > 0;
  const latest =
    timeDimensionIds.length > 0
      ? { last: 1 as const, time_dimension_ids: timeDimensionIds }
      : undefined;
  const unresolvedPlaceTerms = findUnresolvedPlaceTerms(placeQuery, placeMatches);
  const recommendedDataCall =
    hasRecommendedFilters || latest
      ? {
          ...(hasRecommendedFilters ? { filters: recommendedFilters } : {}),
          ...(latest ? { last: latest.last } : {}),
          limit: 20 as const,
        }
      : undefined;
  const guidance: IdescatFilterGuidance = {
    ...(placeMatches.length > 0 ? { place_matches: placeMatches } : {}),
    ...(hasRecommendedFilters ? { recommended_filters: recommendedFilters } : {}),
    ...(latest ? { latest } : {}),
    ...(recommendedDataCall ? { recommended_data_call: recommendedDataCall } : {}),
    ...(unresolvedPlaceTerms.length > 0 ? { unresolved_place_terms: unresolvedPlaceTerms } : {}),
    ...(needsFilterDimensions.length > 0 ? { needs_filter_dimensions: needsFilterDimensions } : {}),
  };

  return Object.keys(guidance).length > 0 ? guidance : undefined;
}

function findPlaceMatches(
  dimensions: IdescatDimensionMetadata[],
  placeQuery?: string,
): IdescatFilterGuidancePlaceMatch[] {
  if (!placeQuery?.trim()) {
    return [];
  }

  const queryTokens = normalizeSearchTerm(placeQuery).split(" ").filter(Boolean);

  if (queryTokens.length === 0) {
    return [];
  }

  const matches: IdescatFilterGuidancePlaceMatch[] = [];

  for (const dimension of dimensions) {
    if (dimension.role !== "geo") {
      continue;
    }

    for (const category of dimension.categories) {
      const categoryTokens = normalizeSearchTerm(category.label).split(" ").filter(Boolean);

      if (categoryTokens.length === 0 || !containsTokenSequence(queryTokens, categoryTokens)) {
        continue;
      }

      matches.push({
        dimension_id: dimension.id,
        dimension_label: dimension.label,
        category_id: category.id,
        category_label: category.label,
      });
    }
  }

  return matches;
}

function groupPlaceMatches(
  matches: IdescatFilterGuidancePlaceMatch[],
): Array<[string, IdescatFilterGuidancePlaceMatch[]]> {
  const grouped = new Map<string, IdescatFilterGuidancePlaceMatch[]>();

  for (const match of matches) {
    grouped.set(match.dimension_id, [...(grouped.get(match.dimension_id) ?? []), match]);
  }

  return [...grouped.entries()];
}

function getSafeDefaultCategory(
  dimension: IdescatDimensionMetadata,
): IdescatDimensionCategory | undefined {
  if (dimension.categories.length === 1) {
    return dimension.categories[0];
  }

  return dimension.categories.find(
    (category) => category.id === "TOTAL" || normalizeSearchTerm(category.label) === "total",
  );
}

function findUnresolvedPlaceTerms(
  placeQuery: string | undefined,
  placeMatches: IdescatFilterGuidancePlaceMatch[],
): string[] {
  if (!placeQuery?.trim()) {
    return [];
  }

  const matchedLabels = new Set(
    placeMatches.map((match) => normalizeSearchTerm(match.category_label)),
  );
  const unresolved = findIdescatPlaceAliasesInText(placeQuery)
    .filter((alias) => !matchedLabels.has(alias.tokens.join(" ")))
    .map((alias) => alias.name);

  if (unresolved.length > 0) {
    return [...new Set(unresolved)];
  }

  return placeMatches.length === 0 ? [placeQuery.trim()] : [];
}

function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length > haystack.length) {
    return false;
  }

  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) {
      return true;
    }
  }

  return false;
}

function toDimensionMetadata(input: {
  dimensionId: string;
  rawDimension: unknown;
  role?: "geo" | "metric" | "time";
  size: number;
}): IdescatDimensionMetadata {
  const dimension = isRecord(input.rawDimension) ? input.rawDimension : {};
  const category = isRecord(dimension.category) ? dimension.category : {};
  const labels = normalizeStringRecord(category.label);
  const ids = getCategoryIds(category.index, labels);
  const parents = normalizeCategoryParents(category);
  const units = normalizeUnits(category.unit);
  const status = normalizeStringRecord(
    isRecord(dimension.extension) ? dimension.extension.status : undefined,
  );
  const extensions = omitKeys(isRecord(dimension.extension) ? dimension.extension : undefined, [
    "break",
    "status",
    "unit",
  ]);
  // Plan-required dimension-level default unit (separate from per-category units),
  // typically surfaced by IDESCAT under `dimension.{id}.extension.unit`.
  const defaultUnit = parseUnit(
    isRecord(dimension.extension) ? dimension.extension.unit : undefined,
  );

  return {
    id: input.dimensionId,
    label: typeof dimension.label === "string" ? dimension.label : input.dimensionId,
    ...(input.role ? { role: input.role } : {}),
    size: input.size,
    ...(defaultUnit ? { unit: defaultUnit } : {}),
    ...(Object.keys(status).length > 0 ? { status } : {}),
    categories: ids.map((id, index) => ({
      id,
      index,
      label: labels[id] ?? id,
      ...(parents[id] ? { parent: parents[id] } : {}),
      ...(units[id] ? { unit: units[id] } : {}),
      ...(status[id] ? { status: status[id] } : {}),
    })),
    ...(parseBreaks(isRecord(dimension.extension) ? dimension.extension.break : undefined).length >
    0
      ? {
          breaks: parseBreaks(
            isRecord(dimension.extension) ? dimension.extension.break : undefined,
          ),
        }
      : {}),
    ...(extensions ? { extensions } : {}),
  };
}

function parseUnit(value: unknown): IdescatUnit | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const unit: IdescatUnit = {
    ...(typeof value.symbol === "string" ? { symbol: value.symbol } : {}),
    ...(typeof value.decimals === "number" ? { decimals: value.decimals } : {}),
  };

  return Object.keys(unit).length > 0 ? unit : undefined;
}

function getDimensionRole(
  dataset: JsonStatDataset,
  dimensionId: string,
): "geo" | "metric" | "time" | undefined {
  const roleValue = (dataset as { role?: unknown }).role;
  const role = isRecord(roleValue) ? roleValue : {};

  for (const roleName of ["geo", "metric", "time"] as const) {
    const dimensions = role[roleName];

    if (Array.isArray(dimensions) && dimensions.includes(dimensionId)) {
      return roleName;
    }
  }

  return undefined;
}

function getCategoryIds(index: unknown, labels: Record<string, string>): string[] {
  if (Array.isArray(index)) {
    return index.filter((value): value is string => typeof value === "string");
  }

  if (isRecord(index)) {
    return Object.entries(index)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id);
  }

  return Object.keys(labels);
}

function normalizeCategoryParents(category: Record<string, unknown>): Record<string, string> {
  const parents = normalizeStringRecord(category.parent);

  if (!isRecord(category.child)) {
    return parents;
  }

  for (const [parentId, children] of Object.entries(category.child)) {
    if (!Array.isArray(children)) {
      continue;
    }

    for (const childId of children) {
      if (typeof childId === "string" && parents[childId] === undefined) {
        parents[childId] = parentId;
      }
    }
  }

  return parents;
}

function parseBreaks(
  value: unknown,
): Array<{ id: string; label: string; raw?: Record<string, unknown>; time: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    if (
      typeof item.time !== "string" ||
      typeof item.id !== "string" ||
      typeof item.label !== "string"
    ) {
      return [];
    }

    return [
      {
        time: item.time,
        id: item.id,
        label: item.label,
        raw: item,
      },
    ];
  });
}

function flattenLinks(link: unknown): IdescatMetadataLink[] {
  if (!isRecord(link)) {
    return [];
  }

  return Object.entries(link).flatMap(([rel, value]) => {
    const items = Array.isArray(value) ? value : [value];

    return items.flatMap((item) => {
      if (!isRecord(item) || typeof item.href !== "string") {
        return [];
      }

      return [
        {
          rel,
          href: item.href,
          ...(typeof item.label === "string" ? { label: item.label } : {}),
          ...(typeof item.class === "string" ? { class: item.class } : {}),
          ...(typeof item.type === "string" ? { type: item.type } : {}),
          ...(isRecord(item.extension) ? { extension: item.extension } : {}),
        },
      ];
    });
  });
}

function getConvenienceLinks(
  links: IdescatMetadataLink[],
  input: NormalizedIdescatTableMetadataInput,
  requestUrl: URL,
): Pick<IdescatTableMetadata, "alternate_geographies" | "correction_links" | "related_tables"> {
  const correctionLinks = links.filter((link) => link.rel === "monitor");
  const alternateGeographies: IdescatMetadataLink[] = [];
  const relatedTables: IdescatMetadataLink[] = [];

  // Plan: classify by URL-segment comparison, NOT by `rel` alone — links under
  // any rel (alternate, related, custom) that resolve to a Tables v2 tuple are
  // candidates for alternate-geography / related-table classification.
  for (const link of links) {
    if (link.rel === "monitor") {
      continue; // already in correctionLinks
    }

    const tuple = extractTupleFromUrl(link.href, requestUrl);

    if (!tuple) {
      // Only push to related_tables when the link actually claims that rel; we
      // do not want to invent related_tables entries from license / terms / etc.
      if (link.rel === "related") {
        relatedTables.push(link);
      }
      continue;
    }

    if (
      tuple.statistics_id === input.statistics_id &&
      tuple.node_id === input.node_id &&
      tuple.table_id === input.table_id &&
      tuple.geo_id !== input.geo_id
    ) {
      alternateGeographies.push(link);
    } else {
      relatedTables.push(link);
    }
  }

  return {
    ...(correctionLinks.length > 0 ? { correction_links: correctionLinks } : {}),
    ...(alternateGeographies.length > 0 ? { alternate_geographies: alternateGeographies } : {}),
    ...(relatedTables.length > 0 ? { related_tables: relatedTables } : {}),
  };
}

const IDESCAT_API_HOST = "api.idescat.cat";

export function extractTupleFromUrl(
  href: string,
  base?: URL,
): Required<
  Pick<IdescatTableMetadataInput, "geo_id" | "node_id" | "statistics_id" | "table_id">
> | null {
  try {
    // Force a trailing slash on the base so relative hrefs resolve as children,
    // not siblings — see resolveCollectionBase in catalog.ts for the same fix.
    const baseUrl = base ?? new URL(`${IDESCAT_TABLES_BASE_URL}/`);
    const baseWithSlash = baseUrl.pathname.endsWith("/")
      ? baseUrl
      : new URL(`${baseUrl.toString()}/`);
    const url = new URL(href, baseWithSlash);

    // Reject non-IDESCAT hosts so an external link with a coincidentally
    // similar path is not classified as an IDESCAT table.
    if (url.host !== IDESCAT_API_HOST) {
      return null;
    }

    const path = url.pathname.replace(/\/+$/u, "");
    const marker = "/taules/v2/";
    const start = path.indexOf(marker);

    if (start < 0) {
      return null;
    }

    const segments = path
      .slice(start + marker.length)
      .split("/")
      .filter(Boolean);

    // Require exactly four segments — additional segments such as `/data` or
    // `/dimension/...` are not table-tuple URLs and must not be classified as
    // alternate geographies or related tables.
    if (segments.length !== 4) {
      return null;
    }

    const [statistics_id, node_id, table_id, geo_id] = segments;

    if (!statistics_id || !node_id || !table_id || !geo_id) {
      return null;
    }

    return {
      statistics_id: decodeURIComponent(statistics_id),
      node_id: decodeURIComponent(node_id),
      table_id: decodeURIComponent(table_id),
      geo_id: decodeURIComponent(geo_id),
    };
  } catch {
    return null;
  }
}

function buildUnits(
  dimensions: IdescatDimensionMetadata[],
): IdescatTableMetadata["units"] | undefined {
  const byDimension: Record<string, Record<string, IdescatUnit>> = {};

  for (const dimension of dimensions) {
    const categoryUnits = Object.fromEntries(
      dimension.categories
        .filter((category) => category.unit)
        .map((category) => [category.id, category.unit as IdescatUnit]),
    );

    if (Object.keys(categoryUnits).length > 0) {
      byDimension[dimension.id] = categoryUnits;
    }
  }

  // Pick a dataset-level default unit from a metric dimension's dimension-level
  // unit when one exists — otherwise the first dimension that exposes one.
  // Without this, datasets that only surface units via `dimension.{id}.extension.unit`
  // would have `metadata.units` undefined even though `metadata.dimensions[*].unit`
  // is populated, and `idescat_get_table_data.data.units` would lose the signal.
  const defaultUnit =
    dimensions.find((d) => d.role === "metric" && d.unit !== undefined)?.unit ??
    dimensions.find((d) => d.unit !== undefined)?.unit;

  if (Object.keys(byDimension).length === 0 && defaultUnit === undefined) {
    return undefined;
  }

  return {
    ...(defaultUnit ? { default: defaultUnit } : {}),
    ...(Object.keys(byDimension).length > 0 ? { by_dimension: byDimension } : {}),
  };
}

function normalizeUnits(value: unknown): Record<string, IdescatUnit> {
  if (!isRecord(value)) {
    return {};
  }

  const units: Record<string, IdescatUnit> = {};

  for (const [id, unit] of Object.entries(value)) {
    if (!isRecord(unit)) {
      continue;
    }

    const parsedUnit: IdescatUnit = {
      ...(typeof unit.symbol === "string" ? { symbol: unit.symbol } : {}),
      ...(typeof unit.decimals === "number" ? { decimals: unit.decimals } : {}),
    };

    if (Object.keys(parsedUnit).length > 0) {
      units[id] = parsedUnit;
    }
  }

  return units;
}

function parseStatusLabels(
  value: unknown,
): Record<string, { label: string; raw?: Record<string, unknown> }> {
  if (!isRecord(value) || !isRecord(value.label)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value.label).flatMap(([code, label]) => {
      if (typeof label === "string") {
        return [[code, { label }]];
      }

      if (isRecord(label) && typeof label.label === "string") {
        return [[code, { label: label.label, raw: label }]];
      }

      return [];
    }),
  );
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values.length > 0 ? values : undefined;
}

function omitKeys(
  value: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  const entries = Object.entries(value).filter(([key]) => !keys.includes(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
