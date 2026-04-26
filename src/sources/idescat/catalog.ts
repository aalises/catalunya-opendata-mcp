import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { getJsonToolResultByteLength } from "../common/caps.js";
import { formatZodError } from "../common/zod.js";
import {
  type FetchIdescatJsonOptions,
  fetchIdescatJson,
  IDESCAT_TABLES_BASE_URL,
  IdescatError,
  type IdescatLanguage,
} from "./client.js";
import { createIdescatOperationProvenance, type IdescatOperationProvenance } from "./metadata.js";
import { buildIdescatUrl, normalizeLimit, normalizeOffset, safePathSegment } from "./request.js";

const collectionSchema = z
  .object({
    class: z.literal("collection"),
    href: z.string().url().optional(),
    label: z.string(),
    link: z
      .object({
        item: z.array(
          z
            .object({
              href: z.string().min(1),
              label: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    version: z.string().optional(),
  })
  .passthrough();

export interface IdescatListInput {
  lang?: IdescatLanguage;
  limit?: number;
  offset?: number;
}

export interface IdescatListNodesInput extends IdescatListInput {
  statistics_id: string;
}

export interface IdescatListTablesInput extends IdescatListNodesInput {
  node_id: string;
}

export interface IdescatListGeosInput extends IdescatListTablesInput {
  table_id: string;
}

export interface IdescatCollectionInfo {
  href: string;
  label: string;
  lang: IdescatLanguage;
  version: string | null;
}

export interface IdescatListData<TItem> {
  collection: IdescatCollectionInfo;
  items: TItem[];
  limit: number;
  offset: number;
  total: number;
  truncated: boolean;
  truncation_reason?: "byte_cap" | "row_cap";
}

export interface IdescatListResult<TItem> {
  data: IdescatListData<TItem>;
  provenance: IdescatOperationProvenance;
}

export interface IdescatStatisticItem {
  href: string;
  label: string;
  statistics_id: string;
}

export interface IdescatNodeItem extends IdescatStatisticItem {
  node_id: string;
}

export interface IdescatTableItem extends IdescatNodeItem {
  table_id: string;
  updated?: string;
}

export interface IdescatGeoItem extends IdescatTableItem {
  geo_id: string;
}

type CollectionItem = z.infer<typeof collectionSchema>["link"]["item"][number];

export async function listIdescatStatistics(
  input: IdescatListInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatListResult<IdescatStatisticItem>> {
  const normalized = normalizeListInput(input, config, 50);
  const url = buildIdescatUrl({ lang: normalized.lang });
  const collection = parseCollection(await fetchIdescatJson({ url }, config, options));
  const collectionBase = resolveCollectionBase(collection.href, url);
  const items = collection.link.item.map((item) => {
    const [statisticsId] = parseCollectionHref(item, [], 1, collectionBase);
    return {
      statistics_id: statisticsId,
      label: item.label,
      href: item.href,
    };
  });

  return createListResult("list_statistics", collection, items, normalized, url, config);
}

export async function listIdescatNodes(
  input: IdescatListNodesInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatListResult<IdescatNodeItem>> {
  const normalized = {
    ...normalizeListInput(input, config, 50),
    statistics_id: safePathSegment("statistics_id", input.statistics_id),
  };
  const url = buildIdescatUrl(normalized);
  const collection = parseCollection(await fetchIdescatJson({ url }, config, options));
  const collectionBase = resolveCollectionBase(collection.href, url);
  const items = collection.link.item.map((item) => {
    const [statisticsId, nodeId] = parseCollectionHref(
      item,
      [normalized.statistics_id],
      2,
      collectionBase,
    );
    return {
      statistics_id: statisticsId,
      node_id: nodeId,
      label: item.label,
      href: item.href,
    };
  });

  return createListResult("list_nodes", collection, items, normalized, url, config);
}

export async function listIdescatTables(
  input: IdescatListTablesInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatListResult<IdescatTableItem>> {
  const normalized = {
    ...normalizeListInput(input, config, 50),
    node_id: safePathSegment("node_id", input.node_id),
    statistics_id: safePathSegment("statistics_id", input.statistics_id),
  };
  const url = buildIdescatUrl(normalized);
  const collection = parseCollection(await fetchIdescatJson({ url }, config, options));
  const collectionBase = resolveCollectionBase(collection.href, url);
  const items = collection.link.item.map((item) => {
    const [statisticsId, nodeId, tableId] = parseCollectionHref(
      item,
      [normalized.statistics_id, normalized.node_id],
      3,
      collectionBase,
    );
    const updated = typeof item.updated === "string" ? item.updated : undefined;
    return {
      statistics_id: statisticsId,
      node_id: nodeId,
      table_id: tableId,
      label: item.label,
      href: item.href,
      ...(updated ? { updated } : {}),
    };
  });

  return createListResult("list_tables", collection, items, normalized, url, config);
}

export async function listIdescatTableGeos(
  input: IdescatListGeosInput,
  config: AppConfig,
  options: FetchIdescatJsonOptions = {},
): Promise<IdescatListResult<IdescatGeoItem>> {
  const normalized = {
    ...normalizeListInput(input, config, 50),
    node_id: safePathSegment("node_id", input.node_id),
    statistics_id: safePathSegment("statistics_id", input.statistics_id),
    table_id: safePathSegment("table_id", input.table_id),
  };
  const url = buildIdescatUrl(normalized);
  const collection = parseCollection(await fetchIdescatJson({ url }, config, options));
  const collectionBase = resolveCollectionBase(collection.href, url);
  const items = collection.link.item.map((item) => {
    const [statisticsId, nodeId, tableId, geoId] = parseCollectionHref(
      item,
      [normalized.statistics_id, normalized.node_id, normalized.table_id],
      4,
      collectionBase,
    );
    return {
      statistics_id: statisticsId,
      node_id: nodeId,
      table_id: tableId,
      geo_id: geoId,
      label: item.label,
      href: item.href,
    };
  });

  return createListResult("list_table_geos", collection, items, normalized, url, config);
}

function parseCollection(raw: unknown): z.infer<typeof collectionSchema> {
  const parsed = collectionSchema.safeParse(raw);

  if (!parsed.success) {
    throw new IdescatError(
      "invalid_response",
      `Invalid IDESCAT collection response: ${formatZodError(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }

  return parsed.data;
}

function normalizeListInput(
  input: IdescatListInput,
  config: AppConfig,
  fallback: number,
): Required<IdescatListInput> {
  return {
    lang: input.lang ?? "ca",
    limit: normalizeLimit(input.limit, config.maxResults, fallback),
    offset: normalizeOffset(input.offset),
  };
}

function createListResult<TItem>(
  operation: string,
  collection: z.infer<typeof collectionSchema>,
  items: TItem[],
  input: Required<IdescatListInput>,
  url: URL,
  config: AppConfig,
): IdescatListResult<TItem> {
  const provenance = createIdescatOperationProvenance(operation, input.lang, url);
  const total = items.length;
  const pageItems = items.slice(input.offset, input.offset + input.limit);
  const rowTruncated = input.offset + input.limit < total;
  let data: IdescatListData<TItem> = {
    collection: {
      href: collection.href ?? url.toString(),
      label: collection.label,
      lang: input.lang,
      version: collection.version ?? null,
    },
    items: pageItems,
    limit: input.limit,
    offset: input.offset,
    total,
    truncated: rowTruncated,
    ...(rowTruncated ? { truncation_reason: "row_cap" as const } : {}),
  };

  while (getJsonToolResultByteLength({ data, provenance }) > config.responseMaxBytes) {
    if (data.items.length === 0) {
      throw new IdescatError(
        "invalid_response",
        "IDESCAT collection response envelope exceeds response cap even after dropping all items.",
      );
    }

    data = {
      ...data,
      items: data.items.slice(0, -1),
      truncated: true,
      truncation_reason: "byte_cap",
    };
  }

  return { data, provenance };
}

function resolveCollectionBase(collectionHref: string | undefined, requestUrl: URL): URL {
  // Prefer the collection's own href as the base for relative item hrefs;
  // fall back to the request URL. Force a trailing slash so
  // `new URL("1180", base)` resolves under base, not as a sibling — without
  // this, `new URL("1180", "https://api.idescat.cat/taules/v2/pmh")` becomes
  // `…/taules/v2/1180` instead of `…/taules/v2/pmh/1180`.
  const candidate = collectionHref ?? requestUrl.toString();

  try {
    const url = new URL(candidate);
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  } catch {
    return new URL(`${IDESCAT_TABLES_BASE_URL}/`);
  }
}

function parseCollectionHref(
  item: CollectionItem,
  parentSegments: string[],
  expectedLength: number,
  collectionBase: URL,
): string[] {
  let url: URL;

  try {
    url = new URL(item.href, collectionBase);
  } catch (error) {
    throw new IdescatError("invalid_response", "IDESCAT collection item has an invalid href.", {
      cause: error,
    });
  }

  const path = url.pathname.replace(/\/+$/u, "");
  const marker = "/taules/v2/";
  const start = path.indexOf(marker);

  if (start < 0) {
    throw new IdescatError(
      "invalid_response",
      "IDESCAT collection item href is outside Tables v2.",
    );
  }

  const segments = path
    .slice(start + marker.length)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (segments.length !== expectedLength) {
    throw new IdescatError(
      "invalid_response",
      "IDESCAT collection item href has unexpected depth.",
    );
  }

  if (!parentSegments.every((segment, index) => segments[index] === segment)) {
    throw new IdescatError(
      "invalid_response",
      "IDESCAT collection item href does not match parent.",
    );
  }

  return segments;
}
