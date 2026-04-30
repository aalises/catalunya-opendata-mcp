import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength } from "../common/caps.js";
import type { JsonValue } from "../common/json-safe.js";
import { formatZodError } from "../common/zod.js";
import {
  BCN_AREA_ROW_ID_FIELD,
  type BcnAreaRef,
  type BcnWgs84Geometry,
  parseBcnWgs84Geometry,
} from "./area.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeLimit,
} from "./catalog.js";
import {
  BcnError,
  buildBcnDatastoreUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
} from "./client.js";
import {
  type BcnCoordinateFields,
  type BcnGeoBboxInput,
  type BcnGeoStrategy,
  inferBcnCoordinateFields,
  normalizeBcnGeoText,
} from "./geo.js";
import { normalizeBcnJsonObject } from "./resource.js";

export const BCN_PLACE_QUERY_MAX_CHARS = 120;
export const BCN_PLACE_QUERY_VARIANT_LIMIT = 3;
export const BCN_PLACE_RESOURCE_ROW_LIMIT = 25;

export type BcnPlaceKind = "facility" | "landmark" | "street" | "neighborhood" | "district";

export interface BcnResolvePlaceInput {
  bbox?: BcnGeoBboxInput;
  kinds?: string[];
  limit?: number;
  query: string;
}

export interface BcnResolvedPlaceCandidate {
  address?: string;
  area_ref?: BcnAreaRef;
  area_ref_unavailable_reason?: string;
  bbox?: BcnGeoBboxInput;
  district?: string;
  kind: BcnPlaceKind;
  lat: number;
  lon: number;
  matched_fields: string[];
  name: string;
  neighborhood?: string;
  score: number;
  source_dataset_name?: string;
  source_package_id?: string;
  source_resource_id: string;
  source_url: string;
}

export interface BcnResolvePlaceData {
  bbox?: BcnGeoBboxInput;
  candidate_count: number;
  candidates: BcnResolvedPlaceCandidate[];
  kinds?: BcnPlaceKind[];
  limit: number;
  query: string;
  query_variants: string[];
  strategy: BcnGeoStrategy;
  truncated: boolean;
}

export interface BcnResolvePlaceResult {
  data: BcnResolvePlaceData;
  provenance: BcnOperationProvenance;
}

interface NormalizedResolvePlaceInput {
  bbox?: BcnGeoBboxInput;
  kinds?: BcnPlaceKind[];
  limit: number;
  query: string;
  queryVariants: string[];
}

export interface BcnPlaceRegistryResource {
  addressFields?: string[];
  categoryFields?: string[];
  coordinateFields?: BcnCoordinateFields;
  dedupeBy?: "name" | "name_and_coordinate";
  defaultKind: BcnPlaceKind;
  districtFields?: string[];
  geometryField?: string;
  nameFields: string[];
  neighborhoodFields?: string[];
  packageId: string;
  priority: number;
  rowLimit?: number;
  searchMode?: "full_scan" | "q";
  sourceDatasetName: string;
  resourceId: string;
  sourceUrl: string;
}

interface CandidateDraft extends BcnResolvedPlaceCandidate {
  dedupeBy: "name" | "name_and_coordinate";
  priority: number;
}

const PLACE_KIND_VALUES = new Set<BcnPlaceKind>([
  "facility",
  "landmark",
  "street",
  "neighborhood",
  "district",
]);

// Keep this registry explicit and source-bounded. Every entry is an Open Data
// BCN DataStore resource with known place fields; no external geocoder is used.
export const BCN_PLACE_REGISTRY: BcnPlaceRegistryResource[] = [
  {
    resourceId: "661fe190-67c8-423a-b8eb-8140f547fde2",
    packageId: "25752522-3528-4c14-b68d-5f09a3e393bd",
    sourceDatasetName: "Open Data BCN building addresses",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/25752522-3528-4c14-b68d-5f09a3e393bd/resource/661fe190-67c8-423a-b8eb-8140f547fde2",
    defaultKind: "street",
    priority: 35,
    dedupeBy: "name",
    nameFields: ["nom_carrer"],
    addressFields: ["nom_carrer"],
    neighborhoodFields: ["nom_barri"],
    districtFields: ["nom_districte"],
    coordinateFields: { lat: "latitud_wgs84", lon: "longitud_wgs84" },
  },
  {
    resourceId: "576bc645-9481-4bc4-b8bf-f5972c20df3f",
    packageId: "808daafa-d9ce-48c0-925a-fa5afdb1ed41",
    sourceDatasetName: "Open Data BCN administrative districts",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/808daafa-d9ce-48c0-925a-fa5afdb1ed41/resource/576bc645-9481-4bc4-b8bf-f5972c20df3f",
    defaultKind: "district",
    priority: 40,
    dedupeBy: "name",
    searchMode: "full_scan",
    rowLimit: 20,
    nameFields: ["nom_districte"],
    districtFields: ["nom_districte"],
    geometryField: "geometria_wgs84",
  },
  {
    resourceId: "b21fa550-56ea-4f4c-9adc-b8009381896e",
    packageId: "808daafa-d9ce-48c0-925a-fa5afdb1ed41",
    sourceDatasetName: "Open Data BCN neighborhoods",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/808daafa-d9ce-48c0-925a-fa5afdb1ed41/resource/b21fa550-56ea-4f4c-9adc-b8009381896e",
    defaultKind: "neighborhood",
    priority: 38,
    dedupeBy: "name",
    searchMode: "full_scan",
    rowLimit: 100,
    nameFields: ["nom_barri"],
    neighborhoodFields: ["nom_barri"],
    districtFields: ["nom_districte"],
    geometryField: "geometria_wgs84",
  },
  {
    resourceId: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    packageId: "fcef8a36-64df-4231-9145-a4a3ef757f02",
    sourceDatasetName: "Open Data BCN municipal facilities",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/fcef8a36-64df-4231-9145-a4a3ef757f02/resource/d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
    defaultKind: "facility",
    priority: 10,
    nameFields: ["name", "institution_name"],
    addressFields: ["addresses_road_name"],
    neighborhoodFields: ["addresses_neighborhood_name"],
    districtFields: ["addresses_district_name"],
    categoryFields: ["secondary_filters_name"],
  },
  {
    resourceId: "b64d32a8-aea5-47a8-9826-479b211f5d46",
    packageId: "5d43ed16-f93a-442f-8853-4bf2191b2d39",
    sourceDatasetName: "Open Data BCN parks and gardens",
    sourceUrl:
      "https://opendata-ajuntament.barcelona.cat/data/dataset/5d43ed16-f93a-442f-8853-4bf2191b2d39/resource/b64d32a8-aea5-47a8-9826-479b211f5d46",
    defaultKind: "landmark",
    priority: 20,
    dedupeBy: "name",
    nameFields: ["name", "institution_name"],
    addressFields: ["addresses_road_name"],
    neighborhoodFields: ["addresses_neighborhood_name"],
    districtFields: ["addresses_district_name"],
    categoryFields: ["secondary_filters_name"],
  },
];

const datastorePlaceResponseSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
          })
          .passthrough(),
      )
      .default([]),
    records: z.array(z.record(z.unknown())).default([]),
    total: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

export async function resolveBcnPlace(
  input: BcnResolvePlaceInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnResolvePlaceResult> {
  const normalized = normalizeResolvePlaceInput(input, config);
  const url = buildBcnDatastoreUrl("datastore_search");
  const drafts: CandidateDraft[] = [];
  let firstResourceError: unknown;
  let successfulResources = 0;
  let upstreamTruncated = false;

  for (const resource of BCN_PLACE_REGISTRY) {
    try {
      const resourceResult = await resolvePlaceFromResource(
        resource,
        normalized,
        url,
        config,
        options,
      );
      successfulResources += 1;
      drafts.push(...resourceResult.candidates);
      upstreamTruncated ||= resourceResult.truncated;
    } catch (error) {
      firstResourceError ??= error;
      options.logger?.debug("place_registry_resource_skipped", {
        resource_id: resource.resourceId,
        source_dataset_name: resource.sourceDatasetName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (successfulResources === 0 && firstResourceError) {
    throw firstResourceError;
  }

  const sortedCandidates = dedupeAndSortCandidates(drafts);
  const candidates = sortedCandidates
    .slice(0, normalized.limit)
    .map(({ dedupeBy: _dedupeBy, priority: _priority, ...candidate }) => candidate);
  const truncated = upstreamTruncated || sortedCandidates.length > candidates.length;
  const provenance = createBcnOperationProvenance("place_resolve", url);
  const data = capPlaceData(
    {
      query: normalized.query,
      query_variants: normalized.queryVariants,
      ...(normalized.kinds ? { kinds: normalized.kinds } : {}),
      ...(normalized.bbox ? { bbox: normalized.bbox } : {}),
      strategy: "datastore",
      limit: normalized.limit,
      candidate_count: candidates.length,
      candidates,
      truncated,
    },
    provenance,
    config.responseMaxBytes,
  );

  return { data, provenance };
}

async function resolvePlaceFromResource(
  resource: BcnPlaceRegistryResource,
  input: NormalizedResolvePlaceInput,
  url: URL,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<{ candidates: CandidateDraft[]; total: number; truncated: boolean }> {
  const candidates: CandidateDraft[] = [];
  const fields = getPlaceResourceFields(resource);
  const queries = resource.searchMode === "full_scan" ? [undefined] : input.queryVariants;
  let total = 0;
  let truncated = false;

  for (const query of queries) {
    const raw = await fetchBcnActionResult(
      {
        method: "POST",
        url,
        body: {
          resource_id: resource.resourceId,
          ...(query ? { q: query } : {}),
          limit: getPlaceResourceLimit(input, resource),
          fields,
        },
      },
      config,
      options,
    );
    const parsed = datastorePlaceResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new BcnError(
        "invalid_response",
        `Invalid Open Data BCN datastore_search place response: ${formatZodError(parsed.error)}`,
        { cause: parsed.error },
      );
    }

    const queryTotal =
      parsed.data.total ?? getFullCount(parsed.data.records) ?? parsed.data.records.length;
    total += queryTotal;
    truncated ||= queryTotal > parsed.data.records.length;

    const coordinateFields = getPlaceCoordinateFields(
      resource,
      parsed.data.fields.map((field) => field.id),
    );

    if (!coordinateFields && !resource.geometryField) {
      continue;
    }

    for (const rawRow of parsed.data.records) {
      const row = normalizeBcnJsonObject(rawRow, "records[]");
      const candidate = createPlaceCandidate(resource, row, coordinateFields, input);

      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return { candidates, total, truncated };
}

function normalizeResolvePlaceInput(
  input: BcnResolvePlaceInput,
  config: AppConfig,
): NormalizedResolvePlaceInput {
  const query = input.query.trim();

  if (!query) {
    throw new BcnError("invalid_input", "query must not be empty.");
  }

  if (query.length > BCN_PLACE_QUERY_MAX_CHARS || /[\r\n]/u.test(query)) {
    throw new BcnError(
      "invalid_input",
      `query must be a single line no longer than ${BCN_PLACE_QUERY_MAX_CHARS} characters.`,
    );
  }

  const kinds = normalizeKinds(input.kinds);

  return {
    query,
    queryVariants: getQueryVariants(query),
    limit: normalizeLimit(input.limit, config.maxResults, 5),
    ...(kinds ? { kinds } : {}),
    ...(input.bbox ? { bbox: normalizePlaceBbox(input.bbox) } : {}),
  };
}

function normalizeKinds(kinds: string[] | undefined): BcnPlaceKind[] | undefined {
  if (!kinds || kinds.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(kinds.map((kind) => kind.trim().toLowerCase()).filter(Boolean))];

  if (normalized.length === 0) {
    throw new BcnError("invalid_input", "kinds must include at least one non-empty value.");
  }

  for (const kind of normalized) {
    if (!PLACE_KIND_VALUES.has(kind as BcnPlaceKind)) {
      throw new BcnError("invalid_input", `Unsupported BCN place kind: ${kind}.`, {
        source_error: {
          allowed_kinds: [...PLACE_KIND_VALUES],
        },
      });
    }
  }

  return normalized as BcnPlaceKind[];
}

function normalizePlaceBbox(bbox: BcnGeoBboxInput): BcnGeoBboxInput {
  const values = [bbox.min_lat, bbox.min_lon, bbox.max_lat, bbox.max_lon];

  if (values.some((value) => !Number.isFinite(value))) {
    throw new BcnError("invalid_input", "bbox values must be finite numbers.");
  }

  if (bbox.min_lat < -90 || bbox.max_lat > 90 || bbox.min_lon < -180 || bbox.max_lon > 180) {
    throw new BcnError("invalid_input", "bbox coordinates are outside valid WGS84 ranges.");
  }

  if (bbox.min_lat > bbox.max_lat || bbox.min_lon > bbox.max_lon) {
    throw new BcnError(
      "invalid_input",
      "bbox min values must be less than or equal to max values.",
    );
  }

  return bbox;
}

function getQueryVariants(query: string): string[] {
  const variants = [query];
  const rawTokens = query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\\/_.,;:-]+/gu, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  const normalizedQuery = normalizeBcnGeoText(query);
  const tokens = normalizedQuery
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  for (const token of [...rawTokens, ...tokens]) {
    if (variants.length >= BCN_PLACE_QUERY_VARIANT_LIMIT) {
      break;
    }

    if (!variants.some((variant) => normalizeBcnPlaceQueryVariant(variant) === token)) {
      variants.push(token);
    }
  }

  return variants;
}

function normalizeBcnPlaceQueryVariant(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\\/_.,;:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function getPlaceResourceFields(resource: BcnPlaceRegistryResource): string[] {
  return [
    ...new Set([
      ...resource.nameFields,
      ...fieldList(resource.addressFields),
      ...fieldList(resource.neighborhoodFields),
      ...fieldList(resource.districtFields),
      ...fieldList(resource.categoryFields),
      ...(resource.geometryField ? [BCN_AREA_ROW_ID_FIELD] : []),
      ...(resource.coordinateFields
        ? [resource.coordinateFields.lat, resource.coordinateFields.lon]
        : resource.geometryField
          ? []
          : ["geo_epgs_4326_lat", "geo_epgs_4326_lon"]),
      ...(resource.geometryField ? [resource.geometryField] : []),
    ]),
  ];
}

function getPlaceResourceLimit(
  input: NormalizedResolvePlaceInput,
  resource: BcnPlaceRegistryResource,
): number {
  if (resource.searchMode === "full_scan") {
    return resource.rowLimit ?? BCN_PLACE_RESOURCE_ROW_LIMIT;
  }

  return Math.min(Math.max(input.limit * 4, 10), resource.rowLimit ?? BCN_PLACE_RESOURCE_ROW_LIMIT);
}

function createPlaceCandidate(
  resource: BcnPlaceRegistryResource,
  row: Record<string, JsonValue>,
  coordinateFields: BcnCoordinateFields | undefined,
  input: NormalizedResolvePlaceInput,
): CandidateDraft | undefined {
  const location = getPlaceCandidateLocation(resource, row, coordinateFields);

  if (!location) {
    return undefined;
  }

  if (input.bbox && !isInBbox(location.point, input.bbox)) {
    return undefined;
  }

  const kind = getCandidateKind(resource, row);

  if (input.kinds && !input.kinds.includes(kind)) {
    return undefined;
  }

  const scoring = scoreCandidate(resource, row, input.query);

  if (scoring.score <= 0) {
    return undefined;
  }

  const rawName = getFirstString(row, resource.nameFields);

  if (!rawName) {
    return undefined;
  }

  const name = formatCandidateName(rawName, kind, input.query);

  return {
    name,
    kind,
    lat: location.point.lat,
    lon: location.point.lon,
    score: scoring.score,
    matched_fields: scoring.matchedFields,
    ...optionalString("address", getAddress(row, resource)),
    ...optionalString("neighborhood", getFirstString(row, fieldList(resource.neighborhoodFields))),
    ...optionalString("district", getFirstString(row, fieldList(resource.districtFields))),
    ...getAreaCandidateMetadata(resource, row, location.geometry),
    source_dataset_name: resource.sourceDatasetName,
    source_resource_id: resource.resourceId,
    source_package_id: resource.packageId,
    source_url: resource.sourceUrl,
    dedupeBy: resource.dedupeBy ?? "name_and_coordinate",
    priority: resource.priority,
  };
}

function getPlaceCoordinateFields(
  resource: BcnPlaceRegistryResource,
  columns: string[],
): BcnCoordinateFields | undefined {
  if (resource.coordinateFields) {
    const lat = findColumn(columns, resource.coordinateFields.lat);
    const lon = findColumn(columns, resource.coordinateFields.lon);
    return lat && lon ? { lat, lon } : undefined;
  }

  try {
    return inferBcnCoordinateFields(columns).coordinate_fields;
  } catch {
    return undefined;
  }
}

function getPlaceCandidateLocation(
  resource: BcnPlaceRegistryResource,
  row: Record<string, JsonValue>,
  coordinateFields: BcnCoordinateFields | undefined,
): { geometry?: BcnWgs84Geometry; point: { lat: number; lon: number } } | undefined {
  if (coordinateFields) {
    const lat = toNumber(row[coordinateFields.lat]);
    const lon = toNumber(row[coordinateFields.lon]);

    if (lat !== undefined && lon !== undefined) {
      return { point: { lat, lon } };
    }
  }

  if (!resource.geometryField) {
    return undefined;
  }

  const geometry = parseBcnWgs84Geometry(row[resource.geometryField]);
  return { geometry, point: geometry.center };
}

function getAreaCandidateMetadata(
  resource: BcnPlaceRegistryResource,
  row: Record<string, JsonValue>,
  geometry: BcnWgs84Geometry | undefined,
):
  | Pick<BcnResolvedPlaceCandidate, "area_ref" | "area_ref_unavailable_reason" | "bbox">
  | Record<string, never> {
  if (!geometry || !resource.geometryField) {
    return {};
  }

  const rowId = row[BCN_AREA_ROW_ID_FIELD];

  if (typeof rowId !== "string" && typeof rowId !== "number") {
    return {
      area_ref_unavailable_reason:
        "Boundary row did not include _id; use bbox for rough narrowing or inspect the source resource.",
      bbox: geometry.bbox,
    };
  }

  return {
    bbox: geometry.bbox,
    area_ref: {
      source_resource_id: resource.resourceId,
      source_package_id: resource.packageId,
      row_id: rowId,
      geometry_field: resource.geometryField,
      geometry_type: geometry.geometry_type,
    },
  };
}

function scoreCandidate(
  resource: BcnPlaceRegistryResource,
  row: Record<string, JsonValue>,
  query: string,
): { matchedFields: string[]; score: number } {
  const normalizedQuery = normalizeBcnGeoText(query);
  const matchedFields = new Set<string>();
  let score = 0;

  for (const field of resource.nameFields) {
    score = Math.max(score, scoreField(row[field], normalizedQuery, 100, 90, 80));
    if (scoreField(row[field], normalizedQuery, 1, 1, 1) > 0) {
      matchedFields.add(field);
    }
  }

  for (const field of fieldList(resource.neighborhoodFields)) {
    const fieldScore = scoreField(row[field], normalizedQuery, 85, 80, 75);
    score = Math.max(score, fieldScore);
    if (fieldScore > 0) {
      matchedFields.add(field);
    }
  }

  for (const field of fieldList(resource.addressFields)) {
    const fieldScore = scoreField(row[field], normalizedQuery, 75, 70, 65);
    score = Math.max(score, fieldScore);
    if (fieldScore > 0) {
      matchedFields.add(field);
    }
  }

  for (const field of fieldList(resource.districtFields)) {
    const fieldScore = scoreField(row[field], normalizedQuery, 55, 50, 45);
    score = Math.max(score, fieldScore);
    if (fieldScore > 0) {
      matchedFields.add(field);
    }
  }

  for (const field of fieldList(resource.categoryFields)) {
    const fieldScore = scoreField(row[field], normalizedQuery, 35, 30, 25);
    score = Math.max(score, fieldScore);
    if (fieldScore > 0) {
      matchedFields.add(field);
    }
  }

  const rank = toNumber(row.rank);
  const rankBoost = rank === undefined ? 0 : Math.max(0, 10 - Math.min(rank * 10, 10));
  const finalScore = score <= 0 ? 0 : score + rankBoost + resource.priority / 10;

  return {
    matchedFields: [...matchedFields].sort(),
    score: Math.round(finalScore * 10) / 10,
  };
}

function scoreField(
  value: JsonValue | undefined,
  normalizedQuery: string,
  exactScore: number,
  prefixScore: number,
  containsScore: number,
): number {
  if (typeof value !== "string" && typeof value !== "number") {
    return 0;
  }

  const normalizedValue = normalizeBcnGeoText(String(value));

  if (!normalizedValue) {
    return 0;
  }

  if (normalizedValue === normalizedQuery) {
    return exactScore;
  }

  if (normalizedValue.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedValue)) {
    return prefixScore;
  }

  if (normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue)) {
    return containsScore;
  }

  return 0;
}

function getCandidateKind(
  resource: BcnPlaceRegistryResource,
  row: Record<string, JsonValue>,
): BcnPlaceKind {
  const category = normalizeBcnGeoText(
    getFirstString(row, fieldList(resource.categoryFields)) ?? "",
  );

  if (category.includes("museu") || category.includes("monument")) {
    return "landmark";
  }

  return resource.defaultKind;
}

function dedupeAndSortCandidates(candidates: CandidateDraft[]): CandidateDraft[] {
  const deduped = new Map<string, CandidateDraft>();

  for (const candidate of candidates) {
    const key = getCandidateDedupeKey(candidate);
    const existing = deduped.get(key);

    if (!existing || compareCandidates(candidate, existing) < 0) {
      deduped.set(key, mergeCandidate(existing, candidate));
    }
  }

  return [...deduped.values()].sort(compareCandidates);
}

function mergeCandidate(
  previous: CandidateDraft | undefined,
  candidate: CandidateDraft,
): CandidateDraft {
  if (!previous) {
    return candidate;
  }

  return {
    ...candidate,
    matched_fields: [...new Set([...previous.matched_fields, ...candidate.matched_fields])].sort(),
    score: Math.max(previous.score, candidate.score),
  };
}

function compareCandidates(a: CandidateDraft, b: CandidateDraft): number {
  return (
    b.score - a.score ||
    b.priority - a.priority ||
    a.name.localeCompare(b.name, "ca") ||
    a.source_resource_id.localeCompare(b.source_resource_id)
  );
}

function getCandidateDedupeKey(candidate: CandidateDraft): string {
  if (candidate.dedupeBy === "name") {
    return [candidate.kind, normalizeBcnGeoText(candidate.name), candidate.source_resource_id].join(
      "|",
    );
  }

  return [
    normalizeBcnGeoText(candidate.name),
    Math.round(candidate.lat * 100_000),
    Math.round(candidate.lon * 100_000),
  ].join("|");
}

function getFullCount(records: Array<Record<string, unknown>>): number | undefined {
  for (const record of records) {
    const value = record._full_count;

    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return value;
    }

    if (typeof value === "string" && /^\d+$/u.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

function getAddress(
  row: Record<string, JsonValue>,
  resource: BcnPlaceRegistryResource,
): string | undefined {
  return getFirstString(row, fieldList(resource.addressFields));
}

function formatCandidateName(name: string, kind: BcnPlaceKind, query: string): string {
  if (kind !== "street") {
    return name;
  }

  const normalizedName = normalizeBcnGeoText(name);
  const normalizedQuery = normalizeBcnGeoText(query);

  if (!normalizedName || !normalizedQuery.includes(normalizedName)) {
    return name;
  }

  if (/^pla[çc]a\b/iu.test(query) && !/^pla[çc]a\b/iu.test(name)) {
    return `Plaça ${name}`;
  }

  if (/^carrer\b/iu.test(query) && !/^carrer\b/iu.test(name)) {
    return `Carrer ${name}`;
  }

  if (/^avinguda\b/iu.test(query) && !/^avinguda\b/iu.test(name)) {
    return `Avinguda ${name}`;
  }

  return name;
}

function fieldList(fields: string[] | undefined): string[] {
  return fields ?? [];
}

function findColumn(columns: string[], field: string): string | undefined {
  return (
    columns.find((column) => column === field) ??
    columns.find((column) => column.toLowerCase() === field.toLowerCase())
  );
}

function getFirstString(row: Record<string, JsonValue>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = row[field];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function optionalString<TName extends string>(
  name: TName,
  value: string | undefined,
): Record<TName, string> | Record<string, never> {
  return value ? ({ [name]: value } as Record<TName, string>) : {};
}

function toNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    return Number.isFinite(normalized) ? normalized : undefined;
  }

  return undefined;
}

function isInBbox(point: { lat: number; lon: number }, bbox: BcnGeoBboxInput): boolean {
  return (
    point.lat >= bbox.min_lat &&
    point.lat <= bbox.max_lat &&
    point.lon >= bbox.min_lon &&
    point.lon <= bbox.max_lon
  );
}

function capPlaceData(
  data: BcnResolvePlaceData,
  provenance: BcnOperationProvenance,
  responseMaxBytes: number,
): BcnResolvePlaceData {
  let cappedData = data;

  while (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    if (cappedData.candidates.length === 0) {
      throw new BcnError(
        "invalid_response",
        "Open Data BCN place resolver response envelope exceeds response cap even after dropping all candidates.",
      );
    }

    const candidates = cappedData.candidates.slice(0, -1);
    cappedData = {
      ...cappedData,
      candidates,
      candidate_count: candidates.length,
      truncated: true,
    };
  }

  return cappedData;
}
