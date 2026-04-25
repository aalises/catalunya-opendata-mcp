import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { formatZodError } from "../common/zod.js";
import type { SocrataDatasetProvenance, SocrataOperationProvenance } from "./catalog.js";
import {
  type FetchSocrataJsonOptions,
  fetchSocrataJson,
  normalizeSourceId,
  SOCRATA_CATALOG_DOMAIN,
  SOCRATA_SOURCE_ID_PATTERN,
  SocrataError,
} from "./client.js";

const socrataViewResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    attribution: z.string().nullable().optional(),
    attributionLink: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    createdAt: z.number().int().nonnegative().nullable().optional(),
    description: z.string().nullable().optional(),
    license: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    licenseId: z.string().nullable().optional(),
    publicationDate: z.number().int().nonnegative().nullable().optional(),
    rowsUpdatedAt: z.number().int().nonnegative().nullable().optional(),
    viewLastModified: z.number().int().nonnegative().nullable().optional(),
    columns: z.array(
      z
        .object({
          name: z.string().min(1),
          dataTypeName: z.string().min(1),
          description: z.string().nullable().optional(),
          fieldName: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface SocrataDescribeDatasetInput {
  source_id: string;
}

export interface SocrataDatasetColumn {
  display_name: string;
  field_name: string;
  datatype: string;
  description: string | null;
}

export interface SocrataDescribeDatasetData {
  title: string;
  description: string | null;
  attribution: string | null;
  attribution_link: string | null;
  license_or_terms: string | null;
  category: string | null;
  source_id: string;
  source_domain: string;
  web_url: string;
  api_endpoint: string;
  created_at: string | null;
  published_at: string | null;
  rows_updated_at: string | null;
  view_last_modified: string | null;
  columns: SocrataDatasetColumn[];
  suggested_next_action: string;
  provenance: SocrataDatasetProvenance;
}

export interface SocrataDescribeDatasetResult {
  data: SocrataDescribeDatasetData;
  provenance: SocrataOperationProvenance;
}

export async function describeSocrataDataset(
  input: SocrataDescribeDatasetInput,
  config: AppConfig,
  options: FetchSocrataJsonOptions = {},
): Promise<SocrataDescribeDatasetResult> {
  const normalizedInput = normalizeInput(input);
  const viewUrl = buildSocrataViewUrl(normalizedInput.source_id);
  const rawView = await fetchSocrataJson(viewUrl, config, options);
  const parsed = socrataViewResponseSchema.safeParse(rawView);

  if (!parsed.success) {
    throw new SocrataError(
      "invalid_response",
      `Invalid Socrata view response: ${formatZodError(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }

  if (parsed.data.id !== normalizedInput.source_id) {
    throw new SocrataError(
      "invalid_response",
      `Socrata view id "${parsed.data.id}" does not match requested source_id "${normalizedInput.source_id}".`,
    );
  }

  return {
    data: toDatasetDescription(parsed.data, normalizedInput.source_id),
    provenance: createSocrataDescribeProvenance(normalizedInput, viewUrl),
  };
}

export function createSocrataDescribeProvenance(
  input: SocrataDescribeDatasetInput,
  viewUrl?: URL,
): SocrataOperationProvenance {
  const trimmedSourceId = input.source_id.trim();
  const resolvedUrl =
    viewUrl ??
    (SOCRATA_SOURCE_ID_PATTERN.test(trimmedSourceId)
      ? buildSocrataViewUrl(trimmedSourceId)
      : new URL(`https://${SOCRATA_CATALOG_DOMAIN}/`));

  return {
    source: "socrata",
    source_url: resolvedUrl.toString(),
    id: `${SOCRATA_CATALOG_DOMAIN}:dataset_describe`,
    last_updated: null,
    license_or_terms: null,
    language: "ca",
  };
}

export function buildSocrataViewUrl(sourceId: string): URL {
  return new URL(`https://${SOCRATA_CATALOG_DOMAIN}/api/views/${sourceId}`);
}

function normalizeInput(input: SocrataDescribeDatasetInput): SocrataDescribeDatasetInput {
  return {
    source_id: normalizeSourceId(input.source_id),
  };
}

function toDatasetDescription(
  view: z.infer<typeof socrataViewResponseSchema>,
  sourceId: string,
): SocrataDescribeDatasetData {
  const webUrl = `https://${SOCRATA_CATALOG_DOMAIN}/d/${sourceId}`;
  const apiEndpoint = `https://${SOCRATA_CATALOG_DOMAIN}/resource/${sourceId}.json`;
  const licenseOrTerms = getLicenseOrTerms(view);
  const lastUpdated = firstIsoTimestamp(
    view.rowsUpdatedAt,
    view.viewLastModified,
    view.publicationDate,
    view.createdAt,
  );

  return {
    title: view.name,
    description: normalizeNullableString(view.description),
    attribution: normalizeNullableString(view.attribution),
    attribution_link: normalizeNullableString(view.attributionLink),
    license_or_terms: licenseOrTerms,
    category: normalizeNullableString(view.category),
    source_id: sourceId,
    source_domain: SOCRATA_CATALOG_DOMAIN,
    web_url: webUrl,
    api_endpoint: apiEndpoint,
    created_at: toIsoTimestamp(view.createdAt),
    published_at: toIsoTimestamp(view.publicationDate),
    rows_updated_at: toIsoTimestamp(view.rowsUpdatedAt),
    view_last_modified: toIsoTimestamp(view.viewLastModified),
    columns: view.columns.map(toDatasetColumn),
    suggested_next_action:
      "Use the returned field_name values to build SODA $select, $where, and $order filters against api_endpoint.",
    provenance: {
      source: "socrata",
      source_url: webUrl,
      id: sourceId,
      last_updated: lastUpdated,
      license_or_terms: licenseOrTerms,
      language: "ca",
    },
  };
}

function toDatasetColumn(
  column: z.infer<typeof socrataViewResponseSchema>["columns"][number],
): SocrataDatasetColumn {
  return {
    display_name: column.name,
    field_name: column.fieldName,
    datatype: column.dataTypeName,
    description: normalizeNullableString(column.description),
  };
}

function getLicenseOrTerms(view: z.infer<typeof socrataViewResponseSchema>): string | null {
  const licenseName = normalizeNullableString(view.license?.name);

  if (licenseName) {
    return licenseName;
  }

  const licenseId = normalizeNullableString(view.licenseId);

  if (!licenseId || licenseId === "SEE_TERMS_OF_USE") {
    return null;
  }

  return licenseId;
}

function firstIsoTimestamp(...timestamps: Array<number | null | undefined>): string | null {
  for (const timestamp of timestamps) {
    const isoTimestamp = toIsoTimestamp(timestamp);

    if (isoTimestamp) {
      return isoTimestamp;
    }
  }

  return null;
}

function toIsoTimestamp(timestamp: number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined) {
    return null;
  }

  const date = new Date(timestamp * 1_000);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
