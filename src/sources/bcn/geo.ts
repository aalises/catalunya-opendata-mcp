import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength, getUtf8ByteLength } from "../common/caps.js";
import type { JsonValue } from "../common/json-safe.js";
import { formatZodError } from "../common/zod.js";
import {
  type BcnAreaFilterData,
  type BcnWgs84Geometry,
  type BcnWithinPlaceInput,
  fetchBcnAreaGeometry,
  isPointInBcnWgs84Geometry,
} from "./area.js";
import {
  type BcnOperationProvenance,
  createBcnOperationProvenance,
  normalizeBcnId,
  normalizeLimit,
  normalizeOffset,
} from "./catalog.js";
import {
  BcnError,
  buildBcnDatastoreUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
} from "./client.js";
import {
  decodePreviewBytes,
  detectCsvDelimiter,
  detectPreviewFormat,
  fetchBcnDownload,
  trimToLastCompleteLine,
} from "./preview.js";
import {
  fetchBcnResourceMetadata,
  getBcnDatastoreFields,
  normalizeBcnJsonObject,
} from "./resource.js";

export const BCN_GEO_RADIUS_DEFAULT_METERS = 500;
export const BCN_GEO_RADIUS_MAX_METERS = 5_000;
export const BCN_GEO_FILTER_TOTAL_MAX_BYTES = 16_384;
export const BCN_GEO_CONTAINS_TOTAL_MAX_BYTES = 16_384;
export const BCN_GEO_DATASTORE_PAGE_SIZE = 1_000;
export const BCN_GEO_JSON_MAX_BYTES = 2_097_152;
export const BCN_SQL_MATCHED_TOTAL_FIELD = "_bcn_matched_total";
export const BCN_SQL_DISTANCE_FIELD = "_bcn_distance_m";
export const BCN_GEO_TRUNCATION_HINTS = {
  byte_cap:
    "download scan reached the byte cap; raise CATALUNYA_MCP_BCN_GEO_SCAN_BYTES, narrow the resource, or use a DataStore-active resource",
  row_cap: "raise limit within maxResults or use offset to page through matched rows",
  scan_cap:
    "scan reached the configured BCN geo row cap; narrow bbox, contains, or filters, or raise CATALUNYA_MCP_BCN_GEO_SCAN_MAX_ROWS",
} as const satisfies Record<BcnGeoTruncationReason, string>;

export interface BcnQueryResourceGeoInput {
  bbox?: BcnGeoBboxInput;
  contains?: Record<string, string>;
  fields?: string[];
  filters?: Record<string, unknown>;
  group_by?: string;
  group_limit?: number;
  lat_field?: string;
  limit?: number;
  lon_field?: string;
  near?: BcnGeoNearInput;
  offset?: number;
  resource_id: string;
  within_place?: BcnWithinPlaceInput;
}

export interface BcnGeoNearInput {
  lat: number;
  lon: number;
  radius_m?: number;
}

export interface BcnGeoBboxInput {
  max_lat: number;
  max_lon: number;
  min_lat: number;
  min_lon: number;
}

export type BcnGeoStrategy = "datastore" | "download_stream";
export type BcnGeoDatastoreMode = "scan" | "sql";
export type BcnGeoTruncationReason = "byte_cap" | "row_cap" | "scan_cap";

export interface BcnCoordinateFields {
  lat: string;
  lon: string;
}

export interface BcnCoordinateFieldInference {
  candidates: BcnCoordinateFields[];
  coordinate_fields: BcnCoordinateFields;
}

export interface BcnGeoRow extends Record<string, JsonValue> {
  _geo: Record<string, JsonValue>;
}

export interface BcnGeoGroup {
  count: number;
  key: JsonValue;
  min_distance_m?: number;
  sample?: Record<string, JsonValue>;
  sample_nearest?: Record<string, JsonValue>;
}

export interface BcnQueryResourceGeoData {
  area_filter?: BcnAreaFilterData;
  bbox?: BcnGeoBboxInput;
  contains?: Record<string, string>;
  coordinate_fields: BcnCoordinateFields;
  datastore_mode?: BcnGeoDatastoreMode;
  fields?: string[];
  filters?: Record<string, JsonValue>;
  group_by?: string;
  group_limit?: number;
  groups?: BcnGeoGroup[];
  limit: number;
  matched_row_count: number;
  near?: Required<BcnGeoNearInput>;
  offset: number;
  logical_request_body?: Record<string, JsonValue>;
  request_method: "GET" | "POST";
  request_url: string;
  resource_id: string;
  row_count: number;
  rows: BcnGeoRow[];
  scanned_row_count: number;
  strategy: BcnGeoStrategy;
  truncated: boolean;
  truncation_hint?: string;
  truncation_reason?: BcnGeoTruncationReason;
  upstream_bbox_total?: number | null;
  upstream_prefilter_total?: number | null;
  upstream_total?: number | null;
}

export interface BcnQueryResourceGeoResult {
  data: BcnQueryResourceGeoData;
  provenance: BcnOperationProvenance;
}

interface NormalizedGeoInput {
  areaFilter?: BcnAreaFilterData;
  areaGeometry?: BcnWgs84Geometry;
  bbox?: BcnGeoBboxInput;
  contains?: Record<string, string>;
  fields?: string[];
  filters?: Record<string, JsonValue>;
  group_by?: string;
  group_limit: number;
  lat_field?: string;
  limit: number;
  lon_field?: string;
  near?: Required<BcnGeoNearInput>;
  offset: number;
  resource_id: string;
  within_place?: BcnWithinPlaceInput;
}

interface GeoScanResult {
  coordinateFields: BcnCoordinateFields;
  datastoreMode?: BcnGeoDatastoreMode;
  logicalRequestBody?: Record<string, JsonValue>;
  matchedRowCount?: number;
  matchedRows: BcnGeoRow[];
  requestMethod: "GET" | "POST";
  requestUrl: URL;
  rowsPrePaged?: boolean;
  rowsSortedByDistance?: boolean;
  scannedRowCount: number;
  strategy: BcnGeoStrategy;
  truncationReason?: BcnGeoTruncationReason;
  upstreamBboxTotal?: number | null;
  upstreamPrefilterTotal?: number | null;
  upstreamTotal?: number | null;
}

interface ParsedGeoRows {
  rows: Record<string, JsonValue>[];
  scanCapped: boolean;
}

const datastoreResponseSchema = z
  .object({
    records: z.array(z.record(z.unknown())).default([]),
    total: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const datastoreSqlResponseSchema = z
  .object({
    records: z.array(z.record(z.unknown())).default([]),
  })
  .passthrough();

export async function queryBcnResourceGeo(
  input: BcnQueryResourceGeoInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnQueryResourceGeoResult> {
  const normalizedInput = normalizeGeoInput(input, config);
  const areaContext = normalizedInput.within_place
    ? await fetchBcnAreaGeometry(normalizedInput.within_place, config, options)
    : undefined;
  const normalized: NormalizedGeoInput = areaContext
    ? {
        ...normalizedInput,
        areaFilter: areaContext.areaFilter,
        areaGeometry: areaContext.geometry,
        bbox: areaContext.areaFilter.bbox,
      }
    : normalizedInput;
  const metadata = await fetchBcnResourceMetadata(normalized.resource_id, config, options, {
    includePackageTitle: false,
  });
  const scan = metadata.datastore_active
    ? await scanDatastoreResource(normalized, config, options)
    : await scanDownloadResource(normalized, metadata, config, options);
  const sortedRows =
    normalized.near && !scan.rowsSortedByDistance
      ? [...scan.matchedRows].sort(compareByDistance)
      : scan.matchedRows;
  const matchedRowCount = scan.matchedRowCount ?? sortedRows.length;
  const pageRows = scan.rowsPrePaged
    ? sortedRows.slice(0, normalized.limit)
    : sortedRows.slice(normalized.offset, normalized.offset + normalized.limit);
  const visibleRows = pageRows.map((row) => projectGeoRow(row, normalized.fields));
  const groups = normalized.group_by
    ? createGroups(sortedRows, normalized.group_by, normalized.group_limit, normalized.fields)
    : undefined;
  const rowCapped = matchedRowCount > normalized.offset + normalized.limit;
  const reason = scan.truncationReason ?? (rowCapped ? "row_cap" : undefined);
  const provenance = createBcnOperationProvenance("resource_geo_query", scan.requestUrl);
  const data = capGeoData(
    withGeoTruncation(
      {
        resource_id: normalized.resource_id,
        strategy: scan.strategy,
        ...(scan.datastoreMode ? { datastore_mode: scan.datastoreMode } : {}),
        request_method: scan.requestMethod,
        request_url: scan.requestUrl.toString(),
        ...(scan.logicalRequestBody ? { logical_request_body: scan.logicalRequestBody } : {}),
        coordinate_fields: scan.coordinateFields,
        ...(normalized.areaFilter ? { area_filter: normalized.areaFilter } : {}),
        ...(normalized.near ? { near: normalized.near } : {}),
        ...(normalized.bbox && !normalized.areaFilter ? { bbox: normalized.bbox } : {}),
        ...(normalized.filters ? { filters: normalized.filters } : {}),
        ...(normalized.contains ? { contains: normalized.contains } : {}),
        ...(normalized.fields ? { fields: normalized.fields } : {}),
        ...(normalized.group_by ? { group_by: normalized.group_by } : {}),
        ...(normalized.group_by ? { group_limit: normalized.group_limit } : {}),
        limit: normalized.limit,
        offset: normalized.offset,
        scanned_row_count: scan.scannedRowCount,
        matched_row_count: matchedRowCount,
        row_count: visibleRows.length,
        rows: visibleRows,
        ...(groups ? { groups } : {}),
        truncated: false,
        ...(scan.upstreamTotal === undefined ? {} : { upstream_total: scan.upstreamTotal }),
        ...(scan.upstreamBboxTotal === undefined
          ? {}
          : { upstream_bbox_total: scan.upstreamBboxTotal }),
        ...(scan.upstreamPrefilterTotal === undefined
          ? {}
          : { upstream_prefilter_total: scan.upstreamPrefilterTotal }),
      },
      reason,
    ),
    provenance,
    config.responseMaxBytes,
  );

  return { data, provenance };
}

export function inferBcnCoordinateFields(
  columns: string[],
  explicit: { lat_field?: string; lon_field?: string } = {},
): BcnCoordinateFieldInference {
  if (explicit.lat_field || explicit.lon_field) {
    if (!explicit.lat_field || !explicit.lon_field) {
      throw new BcnError("invalid_input", "lat_field and lon_field must be provided together.");
    }

    const lat = findColumn(columns, explicit.lat_field);
    const lon = findColumn(columns, explicit.lon_field);

    if (!lat || !lon) {
      throw new BcnError("invalid_input", "Explicit lat_field/lon_field were not found.", {
        source_error: {
          lat_field: explicit.lat_field,
          lon_field: explicit.lon_field,
          available_fields: columns,
        },
      });
    }

    return {
      coordinate_fields: { lat, lon },
      candidates: [{ lat, lon }],
    };
  }

  const candidates = getCoordinateFieldCandidates(columns);

  if (candidates.length === 0) {
    throw new BcnError("invalid_input", "No WGS84 latitude/longitude fields could be inferred.", {
      source_error: {
        available_fields: columns,
        note: "ETRS89 x/y fields are not converted in this helper; pass explicit WGS84 lat_field and lon_field when available.",
      },
    });
  }

  if (candidates.length > 1) {
    throw new BcnError(
      "invalid_input",
      "Multiple possible WGS84 latitude/longitude field pairs were found; pass explicit lat_field and lon_field.",
      {
        source_error: {
          candidates,
        },
      },
    );
  }

  return {
    coordinate_fields: candidates[0],
    candidates,
  };
}

export function normalizeBcnGeoText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\\/_.,;:-]+/gu, " ")
    .replace(
      /\b(c|carrer|calle|avinguda|avenida|av|avda|placa|plaza|pl|pg|passeig|passatge)\b/gu,
      " ",
    )
    .replace(/\b(carretera|ctra|ronda|travessia|travesera|gran via|gv|via|camí|cami)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function getBcnDistanceMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function scanDatastoreResource(
  input: NormalizedGeoInput,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<GeoScanResult> {
  const fields = await getBcnDatastoreFields(input.resource_id, config, options);
  const coordinateFields = inferBcnCoordinateFields(
    fields.map((field) => field.id),
    input,
  ).coordinate_fields;

  if (input.near || input.bbox) {
    return queryDatastoreResourceSql(input, coordinateFields, fields, config, options);
  }

  return scanDatastoreResourcePages(input, coordinateFields, config, options);
}

async function scanDatastoreResourcePages(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<GeoScanResult> {
  const url = buildBcnDatastoreUrl("datastore_search");
  const requestFields = getDatastoreRequestFields(input, coordinateFields);
  const matchedRows: BcnGeoRow[] = [];
  let scannedRowCount = 0;
  let upstreamOffset = 0;
  let upstreamTotal: number | null | undefined;
  let scanCapped = false;

  while (scannedRowCount < config.bcnGeoScanMaxRows) {
    const pageSize = Math.min(
      BCN_GEO_DATASTORE_PAGE_SIZE,
      config.bcnGeoScanMaxRows - scannedRowCount,
    );
    const requestBody = buildDatastoreGeoRequestBody(
      input,
      pageSize,
      upstreamOffset,
      requestFields,
    );
    const raw = await fetchBcnActionResult(
      {
        method: "POST",
        url,
        body: requestBody,
      },
      config,
      options,
    );
    const parsed = datastoreResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new BcnError(
        "invalid_response",
        `Invalid Open Data BCN datastore_search geo response: ${formatZodError(parsed.error)}`,
        { cause: parsed.error },
      );
    }

    if (parsed.data.records.length === 0) {
      upstreamTotal ??= parsed.data.total ?? null;
      break;
    }

    upstreamTotal ??= parsed.data.total ?? null;

    for (const rawRow of parsed.data.records) {
      scannedRowCount += 1;
      const row = normalizeBcnJsonObject(rawRow, "records[]");
      const geoRow = toMatchedGeoRow(row, coordinateFields, input);

      if (geoRow) {
        matchedRows.push(geoRow);
      }
    }

    if (parsed.data.records.length < pageSize) {
      break;
    }

    upstreamOffset += parsed.data.records.length;
  }

  if (scannedRowCount >= config.bcnGeoScanMaxRows) {
    scanCapped = true;
  }

  return {
    strategy: "datastore",
    datastoreMode: "scan",
    requestMethod: "POST",
    requestUrl: url,
    logicalRequestBody: buildDatastoreGeoRequestBody(
      input,
      input.limit,
      input.offset,
      requestFields,
    ),
    coordinateFields,
    scannedRowCount,
    matchedRows,
    ...(upstreamTotal === undefined ? {} : { upstreamTotal }),
    ...(scanCapped ? { truncationReason: "scan_cap" } : {}),
  };
}

async function queryDatastoreResourceSql(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
  fields: Array<{ id: string; type: string }>,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<GeoScanResult> {
  const sqlPlan = buildDatastoreSqlPlan(input, coordinateFields, fields);
  const url = buildBcnDatastoreUrl("datastore_search_sql");
  const matchedRows: BcnGeoRow[] = [];
  let upstreamTotal: number | null | undefined;
  let scannedRowCount = 0;
  let upstreamOffset = sqlPlan.localPostFilterMode ? 0 : input.offset;
  let scanCapped = false;
  const needsFullLocalScan = Boolean(input.group_by);
  const neededMatches = input.offset + input.limit + 1;

  while (true) {
    const pageLimit = sqlPlan.localPostFilterMode
      ? Math.min(BCN_GEO_DATASTORE_PAGE_SIZE, config.bcnGeoScanMaxRows + 1 - scannedRowCount)
      : input.limit + 1;

    if (pageLimit <= 0) {
      scanCapped = true;
      break;
    }

    const records = await fetchDatastoreSqlRecords(
      url,
      sqlPlan.actualSql(pageLimit, upstreamOffset),
      config,
      options,
    );

    if (records.length === 0) {
      upstreamTotal ??= 0;
      break;
    }

    for (const rawRow of records) {
      upstreamTotal ??= getSqlMatchedTotal(normalizeBcnJsonObject(rawRow, "records[]"));

      if (sqlPlan.localPostFilterMode && scannedRowCount >= config.bcnGeoScanMaxRows) {
        scanCapped = true;
        break;
      }

      scannedRowCount += 1;
      const row = normalizeBcnJsonObject(rawRow, "records[]");
      const sourceRow = stripSqlHelperFields(row);
      const geoRow = toMatchedGeoRow(sourceRow, coordinateFields, input);

      if (geoRow) {
        matchedRows.push(geoRow);
      }
    }

    if (scanCapped || records.length < pageLimit || !sqlPlan.localPostFilterMode) {
      break;
    }

    upstreamOffset += records.length;

    if (!needsFullLocalScan && matchedRows.length >= neededMatches) {
      break;
    }
  }

  if (
    sqlPlan.localPostFilterMode &&
    needsFullLocalScan &&
    typeof upstreamTotal === "number" &&
    upstreamTotal > scannedRowCount
  ) {
    scanCapped = true;
  }

  const hasLocalRowFilter = Boolean(input.contains || input.areaGeometry);
  const matchedRowCount = hasLocalRowFilter
    ? matchedRows.length
    : (upstreamTotal ?? matchedRows.length);

  return {
    strategy: "datastore",
    datastoreMode: "sql",
    requestMethod: "POST",
    requestUrl: url,
    logicalRequestBody: { sql: sqlPlan.logicalSql },
    coordinateFields,
    rowsPrePaged: !sqlPlan.localPostFilterMode,
    rowsSortedByDistance: input.near !== undefined,
    scannedRowCount,
    matchedRowCount,
    matchedRows,
    ...(!hasLocalRowFilter ? { upstreamTotal } : {}),
    ...(input.areaGeometry ? { upstreamBboxTotal: upstreamTotal } : {}),
    ...(input.contains ? { upstreamPrefilterTotal: upstreamTotal } : {}),
    ...(scanCapped ? { truncationReason: "scan_cap" as const } : {}),
  };
}

async function fetchDatastoreSqlRecords(
  url: URL,
  sql: string,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<Array<Record<string, unknown>>> {
  const raw = await fetchBcnActionResult(
    {
      method: "POST",
      url,
      body: { sql },
    },
    config,
    options,
  );
  const parsed = datastoreSqlResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN datastore_search_sql geo response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  return parsed.data.records;
}

async function scanDownloadResource(
  input: NormalizedGeoInput,
  metadata: Awaited<ReturnType<typeof fetchBcnResourceMetadata>>,
  config: AppConfig,
  options: FetchBcnJsonOptions,
): Promise<GeoScanResult> {
  if (!metadata.url) {
    throw new BcnError("invalid_input", "Open Data BCN resource does not expose a download URL.");
  }

  const download = await fetchBcnDownload(metadata.url, config, options, config.bcnGeoScanBytes);
  const format = detectPreviewFormat({
    contentType: download.contentType,
    format: metadata.format,
    mimetype: metadata.mimetype,
    url: download.url,
  });
  if (format === "json") {
    assertGeoJsonWithinParseLimit(download.bytes, download.truncated);
  }
  const decoded = decodePreviewBytes(download.bytes, download.contentType);
  const parsedRows =
    format === "csv"
      ? parseGeoCsvRows(decoded.text, download.truncated, config.bcnGeoScanMaxRows)
      : parseGeoJsonRows(decoded.text, download.truncated, config.bcnGeoScanMaxRows);
  const columns = getColumns(parsedRows.rows);
  const coordinateFields = inferBcnCoordinateFields(columns, input).coordinate_fields;
  const matchedRows: BcnGeoRow[] = [];

  for (const row of parsedRows.rows) {
    const geoRow = toMatchedGeoRow(row, coordinateFields, input);

    if (geoRow) {
      matchedRows.push(geoRow);
    }
  }

  return {
    strategy: "download_stream",
    requestMethod: "GET",
    requestUrl: download.url,
    coordinateFields,
    scannedRowCount: parsedRows.rows.length,
    matchedRows,
    ...(download.truncated
      ? { truncationReason: "byte_cap" as const }
      : parsedRows.scanCapped
        ? { truncationReason: "scan_cap" as const }
        : {}),
  };
}

function assertGeoJsonWithinParseLimit(bytes: Uint8Array, truncated: boolean): void {
  if (!truncated && bytes.byteLength <= BCN_GEO_JSON_MAX_BYTES) {
    return;
  }

  throw new BcnError(
    "invalid_input",
    "BCN geo JSON download scans are limited because JSON rows are not streamed; use a DataStore-active resource, a CSV resource, or a smaller JSON download.",
    {
      source_error: {
        limit_bytes: BCN_GEO_JSON_MAX_BYTES,
        received_bytes: bytes.byteLength,
        byte_truncated: truncated,
      },
    },
  );
}

function normalizeGeoInput(input: BcnQueryResourceGeoInput, config: AppConfig): NormalizedGeoInput {
  const filters = input.filters === undefined ? undefined : normalizeFilters(input.filters);
  const contains = input.contains === undefined ? undefined : normalizeContains(input.contains);
  const near = input.near === undefined ? undefined : normalizeNear(input.near);
  const bbox = input.bbox === undefined ? undefined : normalizeBbox(input.bbox);
  const withinPlace =
    input.within_place === undefined ? undefined : normalizeWithinPlace(input.within_place);
  const fields =
    input.fields && input.fields.length > 0 ? normalizeFields(input.fields, "fields") : undefined;
  const groupBy = input.group_by?.trim()
    ? normalizeFieldName(input.group_by, "group_by")
    : undefined;

  if (near && bbox) {
    throw new BcnError("invalid_input", "Pass either near or bbox, not both.");
  }

  if (withinPlace && (near || bbox)) {
    throw new BcnError("invalid_input", "Pass within_place without near or bbox.");
  }

  if (!near && !bbox && !withinPlace && !contains && !filters) {
    throw new BcnError(
      "invalid_input",
      "bcn_query_resource_geo requires at least one narrowing condition: near, bbox, within_place, contains, or filters.",
    );
  }

  return {
    resource_id: normalizeBcnId("resource_id", input.resource_id),
    ...(near ? { near } : {}),
    ...(bbox ? { bbox } : {}),
    ...(withinPlace ? { within_place: withinPlace } : {}),
    ...(filters ? { filters } : {}),
    ...(contains ? { contains } : {}),
    ...(fields ? { fields } : {}),
    ...(groupBy ? { group_by: groupBy } : {}),
    ...(input.lat_field?.trim()
      ? { lat_field: normalizeFieldName(input.lat_field, "lat_field") }
      : {}),
    ...(input.lon_field?.trim()
      ? { lon_field: normalizeFieldName(input.lon_field, "lon_field") }
      : {}),
    limit: normalizeLimit(input.limit, config.maxResults, 20),
    offset: normalizeOffset(input.offset),
    group_limit: normalizeLimit(input.group_limit, config.maxResults, 20),
  };
}

function normalizeWithinPlace(input: BcnWithinPlaceInput): BcnWithinPlaceInput {
  return {
    source_resource_id: normalizeBcnId("within_place.source_resource_id", input.source_resource_id),
    row_id: normalizeWithinPlaceRowId(input.row_id),
    ...(input.geometry_field?.trim()
      ? { geometry_field: normalizeFieldName(input.geometry_field, "within_place.geometry_field") }
      : {}),
  };
}

function normalizeWithinPlaceRowId(rowId: string | number): string | number {
  if (typeof rowId === "number") {
    if (!Number.isSafeInteger(rowId) || rowId < 0) {
      throw new BcnError(
        "invalid_input",
        "within_place.row_id must be a safe non-negative integer.",
      );
    }

    return rowId;
  }

  if (typeof rowId !== "string") {
    throw new BcnError("invalid_input", "within_place.row_id must be a string or number.");
  }

  const normalized = rowId.trim();

  if (!normalized || normalized.length > 128 || /[\r\n]/u.test(normalized)) {
    throw new BcnError("invalid_input", "within_place.row_id contains an invalid row id.");
  }

  return /^\d+$/u.test(normalized) ? Number(normalized) : normalized;
}

function normalizeNear(input: BcnGeoNearInput): Required<BcnGeoNearInput> {
  const lat = normalizeCoordinate(input.lat, "near.lat", -90, 90);
  const lon = normalizeCoordinate(input.lon, "near.lon", -180, 180);
  const radius = input.radius_m ?? BCN_GEO_RADIUS_DEFAULT_METERS;

  if (!Number.isFinite(radius) || radius <= 0 || radius > BCN_GEO_RADIUS_MAX_METERS) {
    throw new BcnError(
      "invalid_input",
      `near.radius_m must be greater than 0 and at most ${BCN_GEO_RADIUS_MAX_METERS}.`,
    );
  }

  return { lat, lon, radius_m: radius };
}

function normalizeBbox(input: BcnGeoBboxInput): BcnGeoBboxInput {
  const bbox = {
    min_lat: normalizeCoordinate(input.min_lat, "bbox.min_lat", -90, 90),
    min_lon: normalizeCoordinate(input.min_lon, "bbox.min_lon", -180, 180),
    max_lat: normalizeCoordinate(input.max_lat, "bbox.max_lat", -90, 90),
    max_lon: normalizeCoordinate(input.max_lon, "bbox.max_lon", -180, 180),
  };

  if (bbox.min_lat >= bbox.max_lat || bbox.min_lon >= bbox.max_lon) {
    throw new BcnError(
      "invalid_input",
      "bbox minimum coordinates must be below maximum coordinates.",
    );
  }

  return bbox;
}

function normalizeCoordinate(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new BcnError("invalid_input", `${name} must be a number between ${min} and ${max}.`);
  }

  return value;
}

function normalizeFilters(filters: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const normalized = normalizeBcnJsonObject(filters, "filters");

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  const byteLength = getUtf8ByteLength(JSON.stringify(normalized));

  if (byteLength > BCN_GEO_FILTER_TOTAL_MAX_BYTES) {
    throw new BcnError(
      "invalid_input",
      `Open Data BCN geo filters exceed the ${BCN_GEO_FILTER_TOTAL_MAX_BYTES}-byte cap.`,
      {
        source_error: {
          rule: "geo_filter_total_bytes",
          observed: byteLength,
          limit: BCN_GEO_FILTER_TOTAL_MAX_BYTES,
        },
      },
    );
  }

  return normalized;
}

function normalizeContains(contains: Record<string, string>): Record<string, string> | undefined {
  if (!isPlainStringRecord(contains)) {
    throw new BcnError(
      "invalid_input",
      "contains must be a plain object of field names to strings.",
    );
  }

  const normalized = Object.fromEntries(
    Object.entries(contains)
      .map(([field, value]) => [normalizeFieldName(field, "contains field"), value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  const byteLength = getUtf8ByteLength(JSON.stringify(normalized));

  if (byteLength > BCN_GEO_CONTAINS_TOTAL_MAX_BYTES) {
    throw new BcnError(
      "invalid_input",
      `Open Data BCN geo contains filters exceed the ${BCN_GEO_CONTAINS_TOTAL_MAX_BYTES}-byte cap.`,
      {
        source_error: {
          rule: "geo_contains_total_bytes",
          observed: byteLength,
          limit: BCN_GEO_CONTAINS_TOTAL_MAX_BYTES,
        },
      },
    );
  }

  return normalized;
}

function normalizeFields(fields: string[], name: string): string[] {
  const normalized = fields.map((field) => normalizeFieldName(field, name));

  if (normalized.length === 0) {
    throw new BcnError("invalid_input", `${name} must include at least one non-empty field name.`);
  }

  return [...new Set(normalized)];
}

function normalizeFieldName(field: string, name: string): string {
  const normalized = field.trim();

  if (!normalized || normalized.length > 128 || /[\r\n]/u.test(normalized)) {
    throw new BcnError("invalid_input", `${name} contains an invalid field name.`);
  }

  return normalized;
}

function getCoordinateFieldCandidates(columns: string[]): BcnCoordinateFields[] {
  const pairs = [
    ["geo_epgs_4326_lat", "geo_epgs_4326_lon"],
    ["geo_epgs_4326_y", "geo_epgs_4326_x"],
    ["latitud_wgs84", "longitud_wgs84"],
    ["latitud", "longitud"],
    ["latitude", "longitude"],
    ["lat", "lon"],
    ["lat", "lng"],
  ] as const;
  const candidates: BcnCoordinateFields[] = [];

  for (const [latName, lonName] of pairs) {
    const lat = findColumn(columns, latName);
    const lon = findColumn(columns, lonName);

    if (
      lat &&
      lon &&
      !candidates.some((candidate) => candidate.lat === lat && candidate.lon === lon)
    ) {
      candidates.push({ lat, lon });
    }
  }

  return candidates;
}

function findColumn(columns: string[], field: string): string | undefined {
  return (
    columns.find((column) => column === field) ??
    columns.find((column) => column.toLowerCase() === field.toLowerCase())
  );
}

function buildDatastoreGeoRequestBody(
  input: NormalizedGeoInput,
  limit: number,
  offset: number,
  fields: string[] | undefined,
): Record<string, JsonValue> {
  return {
    resource_id: input.resource_id,
    limit,
    offset,
    ...(input.filters ? { filters: input.filters } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
  };
}

function getDatastoreRequestFields(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
): string[] | undefined {
  const collected = collectGeoRequestFieldNames(input, coordinateFields);
  return collected ? [...new Set(collected)] : undefined;
}

function collectGeoRequestFieldNames(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
): string[] | undefined {
  if (!input.fields) {
    return undefined;
  }

  return [
    ...input.fields,
    coordinateFields.lat,
    coordinateFields.lon,
    ...(input.group_by ? [input.group_by] : []),
    ...Object.keys(input.filters ?? {}),
    ...Object.keys(input.contains ?? {}),
  ];
}

interface DatastoreSqlPlan {
  actualSql: (limit: number, offset: number) => string;
  localPostFilterMode: boolean;
  logicalSql: string;
}

function buildDatastoreSqlPlan(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
  fields: Array<{ id: string; type: string }>,
): DatastoreSqlPlan {
  const fieldIds = fields.map((field) => field.id);
  const selectedFields = getSqlSelectedFields(input, coordinateFields, fieldIds);
  const whereClauses = [
    ...buildSpatialSqlWhere(input, coordinateFields),
    ...buildFilterSqlWhere(input.filters, fieldIds),
  ];
  const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
  const orderSql = input.near
    ? ` ORDER BY ${getSqlDistanceExpression(input.near, coordinateFields)} ASC`
    : fieldIds.includes("_id")
      ? ' ORDER BY "_id" ASC'
      : "";
  const localPostFilterMode = Boolean(input.group_by || input.contains || input.areaGeometry);
  const actualSelect = buildSqlSelectList(selectedFields, coordinateFields, input.near, true);
  const logicalSelect = buildSqlSelectList(selectedFields, coordinateFields, input.near, false);
  const fromSql = ` FROM ${quoteSqlIdentifier(input.resource_id)}`;

  // logicalSql is the conceptual SQL the caller is logically expressing — it omits
  // the internal _bcn_matched_total window column and uses input.limit/offset.
  // When localPostFilterMode is true the runtime issues paginated upstream calls
  // (LIMIT BCN_GEO_DATASTORE_PAGE_SIZE per page) and applies polygon / contains
  // filters locally, so re-running this SQL verbatim against CKAN will yield only
  // bbox-matching rows, not the post-filtered slice surfaced by the tool.
  return {
    actualSql: (limit, offset) =>
      `${actualSelect}${fromSql}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`,
    localPostFilterMode,
    logicalSql: `${logicalSelect}${fromSql}${whereSql}${orderSql} LIMIT ${input.limit} OFFSET ${input.offset}`,
  };
}

function getSqlSelectedFields(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
  fieldIds: string[],
): string[] | undefined {
  const requested = collectGeoRequestFieldNames(input, coordinateFields);

  if (!requested) {
    return undefined;
  }

  return [...new Set(requested.map((field) => requireSqlField(field, fieldIds)))];
}

function buildSqlSelectList(
  selectedFields: string[] | undefined,
  coordinateFields: BcnCoordinateFields,
  near: Required<BcnGeoNearInput> | undefined,
  includeMatchedTotal: boolean,
): string {
  const selectItems =
    selectedFields === undefined ? ["*"] : selectedFields.map((field) => quoteSqlIdentifier(field));

  if (selectedFields !== undefined) {
    for (const field of [coordinateFields.lat, coordinateFields.lon]) {
      const quoted = quoteSqlIdentifier(field);
      if (!selectItems.includes(quoted)) {
        selectItems.push(quoted);
      }
    }
  }

  if (near) {
    selectItems.push(
      `${getSqlDistanceExpression(near, coordinateFields)} AS ${quoteSqlIdentifier(BCN_SQL_DISTANCE_FIELD)}`,
    );
  }

  if (includeMatchedTotal) {
    selectItems.push(`COUNT(*) OVER() AS ${quoteSqlIdentifier(BCN_SQL_MATCHED_TOTAL_FIELD)}`);
  }

  return `SELECT ${selectItems.join(", ")}`;
}

function buildSpatialSqlWhere(
  input: NormalizedGeoInput,
  coordinateFields: BcnCoordinateFields,
): string[] {
  if (input.near) {
    const bbox = getNearBbox(input.near);
    return [
      ...buildBboxSqlWhere(bbox, coordinateFields),
      `${getSqlDistanceExpression(input.near, coordinateFields)} <= ${formatSqlNumber(input.near.radius_m)}`,
    ];
  }

  return input.bbox ? buildBboxSqlWhere(input.bbox, coordinateFields) : [];
}

function buildBboxSqlWhere(bbox: BcnGeoBboxInput, coordinateFields: BcnCoordinateFields): string[] {
  const latExpr = getSqlCoordinateExpression(coordinateFields.lat);
  const lonExpr = getSqlCoordinateExpression(coordinateFields.lon);

  return [
    `${latExpr} BETWEEN ${formatSqlNumber(bbox.min_lat)} AND ${formatSqlNumber(bbox.max_lat)}`,
    `${lonExpr} BETWEEN ${formatSqlNumber(bbox.min_lon)} AND ${formatSqlNumber(bbox.max_lon)}`,
  ];
}

function buildFilterSqlWhere(
  filters: Record<string, JsonValue> | undefined,
  fieldIds: string[],
): string[] {
  if (!filters) {
    return [];
  }

  return Object.entries(filters).map(([field, value]) =>
    buildFilterSqlClause(requireSqlField(field, fieldIds), value),
  );
}

function buildFilterSqlClause(field: string, value: JsonValue): string {
  const identifier = quoteSqlIdentifier(field);

  if (Array.isArray(value)) {
    const nonNullValues = value.filter((item) => item !== null);
    const clauses: string[] = [];

    if (nonNullValues.some((item) => Array.isArray(item) || typeof item === "object")) {
      throw new BcnError(
        "invalid_input",
        "SQL-backed BCN geo filters support scalar values or arrays of scalar values only.",
        {
          source_error: {
            field,
          },
        },
      );
    }

    if (nonNullValues.length > 0) {
      clauses.push(`${identifier} IN (${nonNullValues.map(formatSqlLiteral).join(", ")})`);
    }

    if (nonNullValues.length !== value.length) {
      clauses.push(`${identifier} IS NULL`);
    }

    if (clauses.length === 0) {
      throw new BcnError("invalid_input", "SQL geo filters cannot use an empty array.");
    }

    return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
  }

  if (value === null) {
    return `${identifier} IS NULL`;
  }

  if (typeof value === "object") {
    throw new BcnError(
      "invalid_input",
      "SQL-backed BCN geo filters support scalar values or arrays of scalar values only.",
      {
        source_error: {
          field,
        },
      },
    );
  }

  return `${identifier} = ${formatSqlLiteral(value)}`;
}

function getSqlDistanceExpression(
  near: Required<BcnGeoNearInput>,
  coordinateFields: BcnCoordinateFields,
): string {
  const latExpr = getSqlCoordinateExpression(coordinateFields.lat);
  const lonExpr = getSqlCoordinateExpression(coordinateFields.lon);
  const nearLat = formatSqlNumber(near.lat);
  const nearLon = formatSqlNumber(near.lon);

  return [
    "(6371000 * 2 * ASIN(SQRT(",
    `POWER(SIN(RADIANS((${latExpr} - ${nearLat}) / 2)), 2)`,
    ` + COS(RADIANS(${nearLat})) * COS(RADIANS(${latExpr})) * POWER(SIN(RADIANS((${lonExpr} - ${nearLon}) / 2)), 2)`,
    ")))",
  ].join("");
}

function getSqlCoordinateExpression(field: string): string {
  const textValue = `NULLIF(TRIM(REPLACE(${quoteSqlIdentifier(field)}::text, ',', '.')), '')`;
  return `(CASE WHEN ${textValue} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${textValue}::double precision ELSE NULL END)`;
}

function getNearBbox(near: Required<BcnGeoNearInput>): BcnGeoBboxInput {
  const latDelta = near.radius_m / 111_320;
  const cosLat = Math.max(Math.cos(toRadians(near.lat)), 0.01);
  const lonDelta = near.radius_m / (111_320 * cosLat);

  return {
    min_lat: Math.max(-90, near.lat - latDelta),
    max_lat: Math.min(90, near.lat + latDelta),
    min_lon: Math.max(-180, near.lon - lonDelta),
    max_lon: Math.min(180, near.lon + lonDelta),
  };
}

function requireSqlField(field: string, fieldIds: string[]): string {
  const resolved = findColumn(fieldIds, field);

  if (!resolved) {
    throw new BcnError(
      "invalid_input",
      `Field ${JSON.stringify(field)} is not in the DataStore schema.`,
      {
        source_error: {
          field,
          available_fields: fieldIds,
        },
      },
    );
  }

  return resolved;
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function formatSqlLiteral(value: JsonValue): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number") {
    return formatSqlNumber(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (Array.isArray(value) || typeof value === "object") {
    throw new BcnError("invalid_input", "SQL geo filters do not support object values.");
  }

  return `'${value.replace(/'/gu, "''")}'`;
}

function formatSqlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new BcnError("invalid_input", "SQL geo numeric value must be finite.");
  }

  return String(value);
}

function getSqlMatchedTotal(row: Record<string, JsonValue>): number | null | undefined {
  const total = row[BCN_SQL_MATCHED_TOTAL_FIELD];

  if (typeof total === "number" && Number.isSafeInteger(total)) {
    return total;
  }

  if (typeof total === "string" && /^\d+$/u.test(total)) {
    return Number(total);
  }

  return undefined;
}

function stripSqlHelperFields(row: Record<string, JsonValue>): Record<string, JsonValue> {
  const cleaned = { ...row };
  delete cleaned[BCN_SQL_MATCHED_TOTAL_FIELD];
  delete cleaned[BCN_SQL_DISTANCE_FIELD];
  return cleaned;
}

function parseGeoCsvRows(text: string, byteTruncated: boolean, maxRows: number): ParsedGeoRows {
  const parseText = byteTruncated ? trimToLastCompleteLine(text) : text;
  const delimiter = detectCsvDelimiter(parseText);
  let parsed: Array<Record<string, unknown>>;

  try {
    parsed = parseCsv(parseText, {
      bom: true,
      columns: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      to: maxRows + 1,
    }) as Array<Record<string, unknown>>;
  } catch (error) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN CSV geo scan could not be parsed; try DataStore querying if this resource is DataStore-active.",
      { cause: error },
    );
  }

  const scanCapped = parsed.length > maxRows;

  return {
    rows: parsed.slice(0, maxRows).map((row) => normalizeBcnJsonObject(row, "csv records[]")),
    scanCapped,
  };
}

function parseGeoJsonRows(text: string, byteTruncated: boolean, maxRows: number): ParsedGeoRows {
  if (byteTruncated) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN JSON geo scan reached the byte cap before a complete JSON document could be read.",
      {
        source_error: {
          rule: "geo_download_byte_cap",
        },
      },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BcnError("invalid_response", "Open Data BCN JSON geo scan could not be parsed.", {
      cause: error,
    });
  }

  const rawRows = Array.isArray(parsed) ? parsed : [parsed];
  const scanRows = rawRows.slice(0, maxRows + 1);
  const scanCapped = scanRows.length > maxRows;

  return {
    rows: scanRows.slice(0, maxRows).map((row) => normalizeBcnJsonObject(row, "json records[]")),
    scanCapped,
  };
}

function toMatchedGeoRow(
  row: Record<string, JsonValue>,
  coordinateFields: BcnCoordinateFields,
  input: NormalizedGeoInput,
): BcnGeoRow | undefined {
  if (!matchesFilters(row, input.filters) || !matchesContains(row, input.contains)) {
    return undefined;
  }

  const lat = toNumber(row[coordinateFields.lat]);
  const lon = toNumber(row[coordinateFields.lon]);

  if (lat === undefined || lon === undefined) {
    return undefined;
  }

  if (input.bbox && !isInBbox({ lat, lon }, input.bbox)) {
    return undefined;
  }

  if (input.areaGeometry && !isPointInBcnWgs84Geometry({ lat, lon }, input.areaGeometry)) {
    return undefined;
  }

  const distance =
    input.near === undefined
      ? undefined
      : getBcnDistanceMeters({ lat: input.near.lat, lon: input.near.lon }, { lat, lon });

  if (input.near && distance !== undefined && distance > input.near.radius_m) {
    return undefined;
  }

  if (Object.hasOwn(row, "_geo")) {
    throw new BcnError(
      "invalid_response",
      "Open Data BCN geo source row already contains a reserved _geo field.",
      {
        source_error: {
          reserved_field: "_geo",
        },
      },
    );
  }

  return {
    ...row,
    _geo: {
      lat,
      lon,
      ...(distance === undefined ? {} : { distance_m: Math.round(distance) }),
    },
  };
}

function projectGeoRow(row: BcnGeoRow, fields: string[] | undefined): BcnGeoRow {
  if (!fields) {
    return row;
  }

  const projected: BcnGeoRow = { _geo: row._geo };

  for (const field of fields) {
    if (field in row) {
      projected[field] = row[field];
    }
  }

  return projected;
}

function matchesFilters(
  row: Record<string, JsonValue>,
  filters: Record<string, JsonValue> | undefined,
): boolean {
  if (!filters) {
    return true;
  }

  for (const [field, expected] of Object.entries(filters)) {
    const actual = row[field];

    if (Array.isArray(expected)) {
      if (!expected.some((item) => jsonEquals(actual, item))) {
        return false;
      }
      continue;
    }

    if (!jsonEquals(actual, expected)) {
      return false;
    }
  }

  return true;
}

function matchesContains(
  row: Record<string, JsonValue>,
  contains: Record<string, string> | undefined,
): boolean {
  if (!contains) {
    return true;
  }

  for (const [field, expected] of Object.entries(contains)) {
    if (!normalizeBcnGeoText(row[field]).includes(normalizeBcnGeoText(expected))) {
      return false;
    }
  }

  return true;
}

function jsonEquals(a: JsonValue | undefined, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

function compareByDistance(a: BcnGeoRow, b: BcnGeoRow): number {
  const distanceA =
    typeof a._geo.distance_m === "number" ? a._geo.distance_m : Number.POSITIVE_INFINITY;
  const distanceB =
    typeof b._geo.distance_m === "number" ? b._geo.distance_m : Number.POSITIVE_INFINITY;
  return distanceA - distanceB;
}

function createGroups(
  rows: BcnGeoRow[],
  field: string,
  limit: number,
  sampleFields: string[] | undefined,
): BcnGeoGroup[] {
  const groups = new Map<string, BcnGeoGroup>();
  const projectedSampleFields = sampleFields ? [...new Set([...sampleFields, field])] : undefined;

  for (const row of rows) {
    const key = row[field] ?? null;
    const mapKey = JSON.stringify(key);
    const existing = groups.get(mapKey);
    const distance = getGeoRowDistance(row);

    if (existing) {
      existing.count += 1;
      if (
        distance !== undefined &&
        (existing.min_distance_m === undefined || distance < existing.min_distance_m)
      ) {
        existing.min_distance_m = distance;
        existing.sample_nearest = projectGeoRow(row, projectedSampleFields);
      }
      continue;
    }

    const sample = projectGeoRow(row, projectedSampleFields);
    groups.set(mapKey, {
      key,
      count: 1,
      sample,
      ...(distance === undefined
        ? {}
        : {
            min_distance_m: distance,
            sample_nearest: sample,
          }),
    });
  }

  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function getGeoRowDistance(row: BcnGeoRow): number | undefined {
  const distance = row._geo.distance_m;

  return typeof distance === "number" && Number.isFinite(distance) ? distance : undefined;
}

function withGeoTruncation(
  data: BcnQueryResourceGeoData,
  reason: BcnGeoTruncationReason | undefined,
): BcnQueryResourceGeoData {
  if (!reason) {
    return data;
  }

  return {
    ...data,
    truncated: true,
    truncation_reason: reason,
    truncation_hint: BCN_GEO_TRUNCATION_HINTS[reason],
  };
}

function capGeoData(
  data: BcnQueryResourceGeoData,
  provenance: BcnOperationProvenance,
  responseMaxBytes: number,
): BcnQueryResourceGeoData {
  let cappedData = data;

  while (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    if (cappedData.rows.length > 0) {
      const rows = cappedData.rows.slice(0, -1);
      cappedData = withGeoTruncation(
        {
          ...cappedData,
          rows,
          row_count: rows.length,
        },
        "byte_cap",
      );
      continue;
    }

    if ((cappedData.groups?.length ?? 0) > 0) {
      const groups = cappedData.groups?.slice(0, -1);
      cappedData = withGeoTruncation(
        {
          ...cappedData,
          ...(groups && groups.length > 0 ? { groups } : { groups: undefined }),
        },
        "byte_cap",
      );
      continue;
    }

    throw new BcnError(
      "invalid_response",
      "Open Data BCN geo response envelope exceeds response cap even after dropping rows and groups.",
    );
  }

  return cappedData;
}

function getColumns(rows: Record<string, JsonValue>[]): string[] {
  const columns = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }

  return [...columns];
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
