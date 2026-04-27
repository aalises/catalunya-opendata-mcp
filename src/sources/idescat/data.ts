import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength } from "../common/caps.js";
import {
  type FetchIdescatJsonOptions,
  fetchIdescatJson,
  IdescatError,
  type IdescatLanguage,
} from "./client.js";
import {
  createIdescatOperationProvenance,
  type IdescatOperationProvenance,
  type IdescatTableMetadata,
  type IdescatTableTupleInput,
  parseIdescatTableMetadata,
} from "./metadata.js";
import {
  buildIdescatDataRequest,
  type NormalizedIdescatFilters,
  normalizeLimit,
  safePathSegment,
} from "./request.js";

export interface IdescatTableDataInput extends IdescatTableTupleInput {
  filters?: Record<string, unknown>;
  last?: number;
  limit?: number;
}

export interface IdescatDataRow {
  dimensions: Record<string, { id: string; label: string }>;
  status?: {
    code: string;
    label?: string;
  };
  value: number | null;
}

export interface IdescatTableData {
  dimension_order: string[];
  filters?: NormalizedIdescatFilters;
  geo_id: string;
  lang: IdescatLanguage;
  last?: number;
  limit: number;
  logical_request_url: string;
  node_id: string;
  notes?: string[];
  request_method: "GET";
  request_url: string;
  row_count: number;
  rows: IdescatDataRow[];
  selected_cell_count: number;
  size: number[];
  source_extensions?: Record<string, unknown>;
  statistics_id: string;
  table_id: string;
  truncated: boolean;
  truncation_hint?: string;
  truncation_reason?: "byte_cap" | "row_cap";
  units?: IdescatTableMetadata["units"];
}

export interface IdescatTableDataResult {
  data: IdescatTableData;
  provenance: IdescatOperationProvenance;
}

interface NormalizedDataInput
  extends Required<
    Pick<IdescatTableTupleInput, "geo_id" | "lang" | "node_id" | "statistics_id" | "table_id">
  > {
  filters?: Record<string, unknown>;
  last?: number;
  limit: number;
}

export async function getIdescatTableData(
  input: IdescatTableDataInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatTableDataResult> {
  const normalizedInput = normalizeDataInput(input, config);
  const builtRequest = buildIdescatDataRequest(normalizedInput);
  const raw = await fetchIdescatJson(builtRequest.request, config, options);
  const metadata = parseIdescatTableMetadata(raw, normalizedInput, builtRequest.logicalRequestUrl);
  const rows = flattenRows(raw, metadata);
  const visibleRows = rows.slice(0, normalizedInput.limit);
  const rowTruncated = rows.length > normalizedInput.limit;
  const provenance = createIdescatOperationProvenance(
    "table_data",
    normalizedInput.lang,
    builtRequest.logicalRequestUrl,
  );
  let data: IdescatTableData = {
    statistics_id: normalizedInput.statistics_id,
    node_id: normalizedInput.node_id,
    table_id: normalizedInput.table_id,
    geo_id: normalizedInput.geo_id,
    lang: normalizedInput.lang,
    request_method: builtRequest.requestMethod,
    request_url: builtRequest.request.url.toString(),
    logical_request_url: builtRequest.logicalRequestUrl.toString(),
    ...(builtRequest.filters ? { filters: builtRequest.filters } : {}),
    ...(builtRequest.last === undefined ? {} : { last: builtRequest.last }),
    limit: normalizedInput.limit,
    dimension_order: metadata.dimensions.map((dimension) => dimension.id),
    size: metadata.dimensions.map((dimension) => dimension.size),
    units: metadata.units,
    selected_cell_count: metadata.dimensions.reduce(
      (product, dimension) => product * dimension.size,
      1,
    ),
    row_count: visibleRows.length,
    rows: visibleRows,
    truncated: rowTruncated,
    ...(rowTruncated
      ? {
          truncation_reason: "row_cap" as const,
          truncation_hint:
            "raise limit (within maxResults) or narrow filters via dimension IDs / _LAST_ -- IDESCAT data tools are for bounded extracts, not exhaustive export",
        }
      : {}),
    ...(metadata.notes ? { notes: metadata.notes } : {}),
    ...(metadata.extensions ? { source_extensions: metadata.extensions } : {}),
  };

  data = capDataEnvelope(data, provenance, config.responseMaxBytes);

  return { data, provenance };
}

function normalizeDataInput(input: IdescatTableDataInput, config: AppConfig): NormalizedDataInput {
  return {
    statistics_id: safePathSegment("statistics_id", input.statistics_id),
    node_id: safePathSegment("node_id", input.node_id),
    table_id: safePathSegment("table_id", input.table_id),
    geo_id: safePathSegment("geo_id", input.geo_id),
    lang: input.lang ?? "ca",
    filters: input.filters,
    last: input.last,
    limit: normalizeLimit(input.limit, config.maxResults, 100),
  };
}

function flattenRows(raw: unknown, metadata: IdescatTableMetadata): IdescatDataRow[] {
  if (!isRecord(raw)) {
    throw new IdescatError("invalid_response", "IDESCAT data response must be an object.");
  }

  const values = getValueEntries(raw.value);
  const cellStatus = getCellStatus(raw.status);
  const rows: IdescatDataRow[] = [];

  for (const [linearIndex, value] of values) {
    const coordinates = toCoordinates(
      linearIndex,
      metadata.dimensions.map((dimension) => dimension.size),
    );
    const dimensions: IdescatDataRow["dimensions"] = {};
    let statusCode = cellStatus.get(linearIndex);

    for (const [dimensionIndex, coordinate] of coordinates.entries()) {
      const dimension = metadata.dimensions[dimensionIndex];
      const category = dimension?.categories[coordinate];

      if (!dimension || !category) {
        throw new IdescatError(
          "invalid_response",
          "IDESCAT data value index is outside dimension bounds.",
        );
      }

      dimensions[dimension.id] = {
        id: category.id,
        label: category.label,
      };

      if (!statusCode && dimension.status?.[category.id]) {
        statusCode = dimension.status[category.id];
      }
    }

    rows.push({
      value,
      dimensions,
      ...(statusCode ? { status: toStatus(statusCode, metadata) } : {}),
    });
  }

  return rows;
}

function getValueEntries(value: unknown): Array<[number, number | null]> {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      Object.hasOwn(value, index) && (typeof item === "number" || item === null)
        ? ([[index, item]] as Array<[number, number | null]>)
        : [],
    );
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => {
      const index = Number.parseInt(key, 10);

      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        (typeof item !== "number" && item !== null)
      ) {
        return [];
      }

      return [[index, item]] as Array<[number, number | null]>;
    });
  }

  throw new IdescatError(
    "invalid_response",
    "IDESCAT data value must be an array or sparse object.",
  );
}

function getCellStatus(status: unknown): Map<number, string> {
  const statuses = new Map<number, string>();

  if (Array.isArray(status)) {
    for (const [index, code] of status.entries()) {
      if (typeof code === "string") {
        statuses.set(index, code);
      }
    }
  }

  if (isRecord(status)) {
    for (const [key, code] of Object.entries(status)) {
      const index = Number.parseInt(key, 10);

      if (Number.isSafeInteger(index) && index >= 0 && typeof code === "string") {
        statuses.set(index, code);
      }
    }
  }

  return statuses;
}

function toCoordinates(linearIndex: number, sizes: number[]): number[] {
  const coordinates = new Array<number>(sizes.length);
  let remainder = linearIndex;

  for (let index = sizes.length - 1; index >= 0; index -= 1) {
    const size = sizes[index] ?? 1;

    if (size < 1) {
      throw new IdescatError(
        "invalid_response",
        "IDESCAT data value index is outside dimension bounds.",
      );
    }

    coordinates[index] = remainder % size;
    remainder = Math.floor(remainder / size);
  }

  if (remainder > 0) {
    throw new IdescatError(
      "invalid_response",
      "IDESCAT data value index is outside dimension bounds.",
    );
  }

  return coordinates;
}

function toStatus(code: string, metadata: IdescatTableMetadata): { code: string; label?: string } {
  return {
    code,
    ...(metadata.status_labels?.[code]?.label ? { label: metadata.status_labels[code].label } : {}),
  };
}

function capDataEnvelope(
  data: IdescatTableData,
  provenance: IdescatOperationProvenance,
  responseMaxBytes: number,
): IdescatTableData {
  let cappedData = data;
  let low = 0;
  let high = cappedData.rows.length;

  if (getJsonToolResultByteLength({ data: cappedData, provenance }) <= responseMaxBytes) {
    return cappedData;
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withByteCapRows(cappedData, cappedData.rows.slice(0, mid));

    if (getJsonToolResultByteLength({ data: candidate, provenance }) <= responseMaxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const rowCount = Math.max(0, low - 1);
  cappedData = withByteCapRows(cappedData, cappedData.rows.slice(0, rowCount));

  if (getJsonToolResultByteLength({ data: cappedData, provenance }) > responseMaxBytes) {
    throw new IdescatError(
      "invalid_response",
      "IDESCAT data response envelope exceeds response cap even after dropping all rows.",
    );
  }

  return cappedData;
}

function withByteCapRows(data: IdescatTableData, rows: IdescatDataRow[]): IdescatTableData {
  return {
    ...data,
    rows,
    row_count: rows.length,
    truncated: true,
    truncation_reason: "byte_cap",
    truncation_hint:
      "narrow filters or use _LAST_ to reduce upstream cells -- IDESCAT data tools are for bounded extracts",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
