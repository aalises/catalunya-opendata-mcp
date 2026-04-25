import { z } from "zod";

import type { AppConfig } from "../../config.js";
import {
  buildSocrataCatalogUrl,
  fetchSocrataCatalog,
  SOCRATA_CATALOG_DOMAIN,
  SocrataCatalogError,
} from "./client.js";

const socrataCatalogResponseSchema = z
  .object({
    resultSetSize: z.number().int().nonnegative(),
    results: z.array(
      z
        .object({
          resource: z
            .object({
              description: z.string().nullable().optional(),
              id: z.string().min(1),
              name: z.string().min(1),
              updatedAt: z.string().min(1),
            })
            .passthrough(),
          metadata: z
            .object({
              domain: z.string().min(1),
              license: z.string().nullable().optional(),
            })
            .passthrough(),
          link: z.string().url().nullable().optional(),
          permalink: z.string().url().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface SocrataSearchDatasetsInput {
  query: string;
  limit: number;
  offset: number;
}

export interface SocrataSearchDatasetsOptions {
  signal?: AbortSignal;
}

interface SocrataProvenanceBase {
  source: "socrata";
  source_url: string;
  id: string;
  language: "ca";
}

export interface SocrataOperationProvenance extends SocrataProvenanceBase {
  last_updated: null;
  license_or_terms: null;
}

export interface SocrataDatasetProvenance extends SocrataProvenanceBase {
  last_updated: string;
  license_or_terms: string | null;
}

export interface SocrataDatasetCard {
  title: string;
  description: string | null;
  source_id: string;
  source_domain: string;
  api_endpoint: string;
  web_url: string;
  updated_at: string;
  provenance: SocrataDatasetProvenance;
}

export interface SocrataSearchDatasetsData {
  query: string;
  limit: number;
  offset: number;
  total: number;
  results: SocrataDatasetCard[];
}

export interface SocrataSearchDatasetsResult {
  data: SocrataSearchDatasetsData;
  provenance: SocrataOperationProvenance;
}

export async function searchSocrataDatasets(
  input: SocrataSearchDatasetsInput,
  config: AppConfig,
  options: SocrataSearchDatasetsOptions = {},
): Promise<SocrataSearchDatasetsResult> {
  const normalizedInput = normalizeInput(input);
  const catalogUrl = buildSocrataCatalogUrl(normalizedInput);
  const rawCatalog = await fetchSocrataCatalog(catalogUrl, config, options);
  const parsed = socrataCatalogResponseSchema.safeParse(rawCatalog);

  if (!parsed.success) {
    throw new SocrataCatalogError(
      "invalid_response",
      `Invalid Socrata catalog response: ${formatZodError(parsed.error)}`,
      {
        cause: parsed.error,
      },
    );
  }

  return {
    data: {
      ...normalizedInput,
      total: parsed.data.resultSetSize,
      results: parsed.data.results.map(toDatasetCard),
    },
    provenance: createSocrataSearchProvenance(normalizedInput, catalogUrl),
  };
}

export function createSocrataSearchProvenance(
  input: SocrataSearchDatasetsInput,
  catalogUrl = buildSocrataCatalogUrl(normalizeInput(input)),
): SocrataOperationProvenance {
  return {
    source: "socrata",
    source_url: catalogUrl.toString(),
    id: `${SOCRATA_CATALOG_DOMAIN}:catalog_search`,
    last_updated: null,
    license_or_terms: null,
    language: "ca",
  };
}

function normalizeInput(input: SocrataSearchDatasetsInput): SocrataSearchDatasetsInput {
  return {
    query: input.query.trim(),
    limit: input.limit,
    offset: input.offset,
  };
}

function toDatasetCard(
  result: z.infer<typeof socrataCatalogResponseSchema>["results"][number],
): SocrataDatasetCard {
  const { resource, metadata } = result;
  const sourceDomain = metadata.domain;
  const webUrl = result.permalink ?? result.link ?? `https://${sourceDomain}/d/${resource.id}`;
  const updatedAt = resource.updatedAt;

  return {
    title: resource.name,
    description: resource.description ?? null,
    source_id: resource.id,
    source_domain: sourceDomain,
    // Synthesize the SODA API endpoint; catalog links are human-facing portal URLs.
    api_endpoint: `https://${sourceDomain}/resource/${resource.id}.json`,
    web_url: webUrl,
    updated_at: updatedAt,
    provenance: {
      source: "socrata",
      source_url: webUrl,
      id: resource.id,
      last_updated: updatedAt,
      license_or_terms: metadata.license ?? null,
      language: "ca",
    },
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
}
