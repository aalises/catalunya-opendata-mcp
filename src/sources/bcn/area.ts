import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { JsonValue } from "../common/json-safe.js";
import { formatZodError } from "../common/zod.js";
import { normalizeBcnId } from "./catalog.js";
import {
  BcnError,
  buildBcnDatastoreUrl,
  type FetchBcnJsonOptions,
  fetchBcnActionResult,
} from "./client.js";
import type { BcnGeoBboxInput } from "./geo.js";
import { normalizeBcnJsonObject } from "./resource.js";

export const BCN_AREA_DEFAULT_GEOMETRY_FIELD = "geometria_wgs84";
export const BCN_AREA_ROW_ID_FIELD = "_id";

export interface BcnAreaRef {
  geometry_field: string;
  geometry_type: BcnAreaGeometryType;
  row_id: string | number;
  source_package_id?: string;
  source_resource_id: string;
}

export interface BcnWithinPlaceInput {
  geometry_field?: string;
  row_id: string | number;
  source_resource_id: string;
}

export interface BcnAreaFilterData {
  bbox: BcnGeoBboxInput;
  geometry_field: string;
  geometry_type: BcnAreaGeometryType;
  mode: "polygon";
  row_id: string | number;
  source_resource_id: string;
}

export type BcnAreaGeometryType = "polygon" | "multipolygon";

export interface BcnWgs84Geometry {
  bbox: BcnGeoBboxInput;
  center: {
    lat: number;
    lon: number;
  };
  geometry_type: BcnAreaGeometryType;
  polygons: Array<Array<Array<{ lat: number; lon: number }>>>;
  rings: Array<Array<{ lat: number; lon: number }>>;
}

const datastoreAreaResponseSchema = z
  .object({
    records: z.array(z.record(z.unknown())).default([]),
  })
  .passthrough();

export async function fetchBcnAreaGeometry(
  input: BcnWithinPlaceInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<{ areaFilter: BcnAreaFilterData; geometry: BcnWgs84Geometry }> {
  const sourceResourceId = normalizeBcnId(
    "within_place.source_resource_id",
    input.source_resource_id,
  );
  const geometryField = normalizeAreaFieldName(
    input.geometry_field ?? BCN_AREA_DEFAULT_GEOMETRY_FIELD,
    "within_place.geometry_field",
  );
  const rowId = normalizeAreaRowId(input.row_id);
  const url = buildBcnDatastoreUrl("datastore_search");
  const raw = await fetchBcnActionResult(
    {
      method: "POST",
      url,
      body: {
        resource_id: sourceResourceId,
        filters: {
          [BCN_AREA_ROW_ID_FIELD]: rowId,
        },
        fields: [BCN_AREA_ROW_ID_FIELD, geometryField],
        limit: 1,
      },
    },
    config,
    options,
  );
  const parsed = datastoreAreaResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new BcnError(
      "invalid_response",
      `Invalid Open Data BCN area lookup response: ${formatZodError(parsed.error)}`,
      { cause: parsed.error },
    );
  }

  const record = parsed.data.records[0];

  if (!record) {
    throw new BcnError("invalid_input", "within_place did not match a BCN area row.", {
      source_error: {
        row_id: rowId,
        source_resource_id: sourceResourceId,
      },
    });
  }

  const row = normalizeBcnJsonObject(record, "records[]");
  const geometry = parseBcnWgs84Geometry(row[geometryField]);

  return {
    geometry,
    areaFilter: {
      mode: "polygon",
      source_resource_id: sourceResourceId,
      row_id: rowId,
      geometry_field: geometryField,
      geometry_type: geometry.geometry_type,
      bbox: geometry.bbox,
    },
  };
}

export function parseBcnWgs84Geometry(value: JsonValue | undefined): BcnWgs84Geometry {
  if (typeof value !== "string" || !value.trim()) {
    throw new BcnError("invalid_response", "BCN area geometry is missing or not a string.");
  }

  const normalized = value.trim();
  const geometryType = getBcnAreaGeometryType(normalized);
  const polygons = parseWktPolygons(normalized, geometryType);
  const rings = polygons.flat();

  if (rings.length === 0) {
    throw new BcnError("invalid_response", "BCN area geometry did not contain WGS84 rings.");
  }

  const bbox = getRingsBbox(rings);

  return {
    geometry_type: geometryType,
    polygons,
    rings,
    bbox,
    center: {
      lat: (bbox.min_lat + bbox.max_lat) / 2,
      lon: (bbox.min_lon + bbox.max_lon) / 2,
    },
  };
}

export function isPointInBcnWgs84Geometry(
  point: { lat: number; lon: number },
  geometry: BcnWgs84Geometry,
): boolean {
  if (!isPointInBbox(point, geometry.bbox)) {
    return false;
  }

  return geometry.polygons.some((polygon) => isPointInPolygon(point, polygon));
}

export function isPointInBbox(point: { lat: number; lon: number }, bbox: BcnGeoBboxInput): boolean {
  return (
    point.lat >= bbox.min_lat &&
    point.lat <= bbox.max_lat &&
    point.lon >= bbox.min_lon &&
    point.lon <= bbox.max_lon
  );
}

export function normalizeAreaFieldName(field: string, name: string): string {
  const normalized = field.trim();

  if (!normalized || normalized.length > 128 || /[\r\n]/u.test(normalized)) {
    throw new BcnError("invalid_input", `${name} contains an invalid field name.`);
  }

  return normalized;
}

function getBcnAreaGeometryType(wkt: string): BcnAreaGeometryType {
  const type = wkt.split(/\s+/u)[0]?.toUpperCase();

  if (type === "POLYGON") {
    return "polygon";
  }

  if (type === "MULTIPOLYGON") {
    return "multipolygon";
  }

  throw new BcnError(
    "invalid_response",
    `Unsupported BCN area geometry type: ${type ?? "unknown"}.`,
  );
}

function parseWktPolygons(
  wkt: string,
  geometryType: BcnAreaGeometryType,
): Array<Array<Array<{ lat: number; lon: number }>>> {
  const body = getWktBody(wkt);

  if (geometryType === "polygon") {
    return [parseWktPolygonBody(body)];
  }

  return extractTopLevelParenthesizedGroups(body)
    .map(parseWktPolygonBody)
    .filter((polygon) => polygon.length > 0);
}

function parseWktPolygonBody(value: string): Array<Array<{ lat: number; lon: number }>> {
  return extractTopLevelParenthesizedGroups(value)
    .map(parseWktRing)
    .filter((ring) => ring.length >= 4);
}

function getWktBody(wkt: string): string {
  const start = wkt.indexOf("(");
  const end = wkt.lastIndexOf(")");

  if (start < 0 || end <= start) {
    throw new BcnError("invalid_response", "BCN area geometry has invalid WKT parentheses.");
  }

  return wkt.slice(start + 1, end).trim();
}

function extractTopLevelParenthesizedGroups(value: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "(") {
      if (depth === 0) {
        start = index + 1;
      }
      depth += 1;
      continue;
    }

    if (char !== ")") {
      continue;
    }

    depth -= 1;

    if (depth < 0) {
      throw new BcnError("invalid_response", "BCN area geometry has unbalanced WKT parentheses.");
    }

    if (depth === 0 && start >= 0) {
      groups.push(value.slice(start, index).trim());
      start = -1;
    }
  }

  if (depth !== 0) {
    throw new BcnError("invalid_response", "BCN area geometry has unbalanced WKT parentheses.");
  }

  return groups;
}

function parseWktRing(value: string): Array<{ lat: number; lon: number }> {
  return value
    .split(",")
    .map((pair) => {
      const [lonRaw, latRaw] = pair.trim().split(/\s+/u);
      const lon = Number(lonRaw);
      const lat = Number(latRaw);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        return undefined;
      }

      return { lat, lon };
    })
    .filter((point): point is { lat: number; lon: number } => point !== undefined);
}

function getRingsBbox(rings: Array<Array<{ lat: number; lon: number }>>): BcnGeoBboxInput {
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const point of ring) {
      minLat = Math.min(minLat, point.lat);
      minLon = Math.min(minLon, point.lon);
      maxLat = Math.max(maxLat, point.lat);
      maxLon = Math.max(maxLon, point.lon);
    }
  }

  return {
    min_lat: minLat,
    min_lon: minLon,
    max_lat: maxLat,
    max_lon: maxLon,
  };
}

function isPointInRing(
  point: { lat: number; lon: number },
  ring: Array<{ lat: number; lon: number }>,
): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const current = ring[i];
    const previous = ring[j];
    const intersects =
      current.lat > point.lat !== previous.lat > point.lat &&
      point.lon <
        ((previous.lon - current.lon) * (point.lat - current.lat)) / (previous.lat - current.lat) +
          current.lon;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function isPointInPolygon(
  point: { lat: number; lon: number },
  polygon: Array<Array<{ lat: number; lon: number }>>,
): boolean {
  const [outerRing, ...holes] = polygon;

  if (!outerRing || !isPointInRing(point, outerRing)) {
    return false;
  }

  return !holes.some((hole) => isPointInRing(point, hole));
}

function normalizeAreaRowId(rowId: string | number): string | number {
  if (typeof rowId === "number") {
    if (!Number.isSafeInteger(rowId) || rowId < 0) {
      throw new BcnError(
        "invalid_input",
        "within_place.row_id must be a non-negative safe integer.",
      );
    }

    return rowId;
  }

  const normalized = rowId.trim();

  if (!normalized || normalized.length > 128 || /[\r\n]/u.test(normalized)) {
    throw new BcnError("invalid_input", "within_place.row_id contains an invalid value.");
  }

  return /^\d+$/u.test(normalized) ? Number(normalized) : normalized;
}
