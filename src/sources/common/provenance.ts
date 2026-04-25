import type { SourceId } from "./errors.js";

export type SourceLanguage = "ca" | "en" | "es";

export interface SourceProvenance<TSource extends SourceId = SourceId> {
  source: TSource;
  source_url: string;
  id: string;
  last_updated: string | null;
  license_or_terms: string | null;
  language: SourceLanguage;
}

export interface SourceOperationProvenance<TSource extends SourceId = SourceId>
  extends SourceProvenance<TSource> {
  last_updated: null;
  license_or_terms: null;
}

export type SourceDatasetProvenance<TSource extends SourceId = SourceId> =
  SourceProvenance<TSource>;
