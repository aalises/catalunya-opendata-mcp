import type { AppConfig } from "../../config.js";
import type { JsonValue } from "../common/json-safe.js";
import { type BcnOperationProvenance, createBcnOperationProvenance } from "./catalog.js";
import {
  type BcnCityCitationGuidance,
  type BcnCityExecuteQueryData,
  type BcnCityFinalTool,
  type BcnCityPlanData,
  type BcnCityQueryExecutionStatus,
  type BcnCityQueryInput,
  executeBcnCityQuery,
} from "./city-query.js";
import type { FetchBcnJsonOptions } from "./client.js";

export type BcnCityAnswerType =
  | "blocked"
  | "empty_result"
  | "grouped_counts"
  | "nearest_rows"
  | "preview_sample"
  | "row_sample";

export interface BcnCityAnswerSelectedResource {
  datastore_active: boolean;
  format: string | null;
  package_id: string | null;
  resource_id: string;
  source_url: string;
  theme?: string;
  title: string;
}

export interface BcnCityAnswerData {
  answer_text: string;
  answer_type: BcnCityAnswerType;
  caveats: string[];
  citation: BcnCityCitationGuidance;
  execution_notes: string[];
  execution_status: BcnCityQueryExecutionStatus;
  final_arguments?: Record<string, JsonValue>;
  final_result: Record<string, JsonValue> | null;
  final_tool?: BcnCityFinalTool;
  plan: BcnCityPlanData;
  selected_resource?: BcnCityAnswerSelectedResource;
  summary: Record<string, JsonValue>;
}

export interface BcnCityAnswerQueryResult {
  data: BcnCityAnswerData;
  provenance: BcnOperationProvenance;
}

type JsonRecord = Record<string, JsonValue>;

const SUMMARY_ROW_LIMIT = 5;

export async function answerBcnCityQuery(
  input: BcnCityQueryInput,
  config: AppConfig,
  options: FetchBcnJsonOptions = {},
): Promise<BcnCityAnswerQueryResult> {
  const execution = await executeBcnCityQuery(input, config, options);
  const finalResult = execution.data.final_result ?? null;
  const composed = composeCityAnswer(execution.data, finalResult);

  return {
    data: {
      ...composed,
      citation: execution.data.plan.citation,
      execution_status: execution.data.execution_status,
      ...(execution.data.final_arguments
        ? { final_arguments: execution.data.final_arguments }
        : {}),
      final_result: finalResult,
      ...(execution.data.final_tool ? { final_tool: execution.data.final_tool } : {}),
      plan: execution.data.plan,
      ...(getSelectedResource(execution.data.plan)
        ? { selected_resource: getSelectedResource(execution.data.plan) }
        : {}),
    },
    provenance: createBcnOperationProvenance("city_query_answer"),
  };
}

function composeCityAnswer(
  execution: BcnCityExecuteQueryData,
  finalResult: Record<string, JsonValue> | null,
): Pick<
  BcnCityAnswerData,
  "answer_text" | "answer_type" | "caveats" | "execution_notes" | "summary"
> {
  const finalData = getFinalData(finalResult);
  const notes = collectAnswerNotes(execution, finalData);

  if (execution.execution_status === "blocked" || !finalData) {
    return {
      answer_text: buildBlockedAnswer(execution.plan),
      answer_type: "blocked",
      caveats: notes.caveats,
      execution_notes: notes.execution_notes,
      summary: buildBlockedSummary(execution.plan),
    };
  }

  const groups = getRecordArray(finalData.groups);
  const rows = getRecordArray(finalData.rows);

  if (groups.length > 0) {
    return {
      answer_text: buildGroupedAnswer(execution.plan, finalData, groups),
      answer_type: "grouped_counts",
      caveats: notes.caveats,
      execution_notes: notes.execution_notes,
      summary: buildGroupedSummary(execution.plan, finalData, groups),
    };
  }

  if (isEmptyFinalData(finalData)) {
    return {
      answer_text: buildEmptyAnswer(execution.plan),
      answer_type: "empty_result",
      caveats: notes.caveats,
      execution_notes: notes.execution_notes,
      summary: buildRowSummary(execution.plan, finalData, []),
    };
  }

  if (isRecord(finalData.near)) {
    return {
      answer_text: buildNearestAnswer(execution.plan, finalData, rows),
      answer_type: "nearest_rows",
      caveats: notes.caveats,
      execution_notes: notes.execution_notes,
      summary: buildRowSummary(execution.plan, finalData, rows),
    };
  }

  const answerType =
    execution.final_tool === "bcn_preview_resource" ? "preview_sample" : "row_sample";

  return {
    answer_text: buildRowSampleAnswer(execution.plan, finalData, rows, answerType),
    answer_type: answerType,
    caveats: notes.caveats,
    execution_notes: notes.execution_notes,
    summary: buildRowSummary(execution.plan, finalData, rows),
  };
}

function buildBlockedAnswer(plan: BcnCityPlanData): string {
  if (plan.status === "needs_place_selection") {
    const candidateCount = plan.place_resolution?.candidate_count ?? 0;
    return `Cannot answer "${plan.intent.query}" deterministically yet: select one Barcelona place candidate from ${formatCount(candidateCount, "candidate")}.`;
  }

  if (plan.status === "needs_resource_selection") {
    const recommendationCount = plan.recommendations?.length ?? 0;
    return `Cannot answer "${plan.intent.query}" deterministically yet: select one BCN resource from ${formatCount(recommendationCount, "recommendation")}.`;
  }

  return `Cannot answer "${plan.intent.query}" deterministically with the current BCN city-query planner.`;
}

function buildGroupedAnswer(plan: BcnCityPlanData, data: JsonRecord, groups: JsonRecord[]): string {
  const groupBy = getString(data.group_by) ?? "group";
  const groupText = groups
    .slice(0, SUMMARY_ROW_LIMIT)
    .map((group) => `${formatJsonValue(group.key)} (${getNumber(group.count) ?? 0})`)
    .join(", ");
  const matchedText = getMatchedText(data);
  const areaText = getAreaProvenanceSentence(plan, data);

  return compactSentences([
    `For "${plan.intent.query}", top ${groupBy} values are ${groupText}.`,
    matchedText,
    areaText,
  ]);
}

function buildNearestAnswer(plan: BcnCityPlanData, data: JsonRecord, rows: JsonRecord[]): string {
  const rowText = rows.slice(0, SUMMARY_ROW_LIMIT).map(formatNearestRow).join(", ");
  const near = isRecord(data.near) ? data.near : undefined;
  const radius = near ? getNumber(near.radius_m) : undefined;
  const radiusText = radius === undefined ? undefined : `within ${Math.round(radius)} m`;
  const matchedText = getMatchedText(data, radiusText);

  return compactSentences([
    `Closest results for "${plan.intent.query}" are ${rowText}.`,
    matchedText,
  ]);
}

function buildRowSampleAnswer(
  plan: BcnCityPlanData,
  data: JsonRecord,
  rows: JsonRecord[],
  answerType: "preview_sample" | "row_sample",
): string {
  const labels = rows
    .slice(0, SUMMARY_ROW_LIMIT)
    .map((row) => getRowLabel(row))
    .join(", ");
  const prefix = answerType === "preview_sample" ? "Preview sample" : "Rows";
  const matchedText = getMatchedText(data);
  const areaText = getAreaProvenanceSentence(plan, data);

  return compactSentences([
    `${prefix} for "${plan.intent.query}": ${labels}.`,
    matchedText,
    areaText,
  ]);
}

function buildEmptyAnswer(plan: BcnCityPlanData): string {
  return `No rows matched "${plan.intent.query}" in the selected Open Data BCN resource.`;
}

function buildBlockedSummary(plan: BcnCityPlanData): Record<string, JsonValue> {
  return {
    query: plan.intent.query,
    status: plan.status,
    ...(plan.place_resolution
      ? {
          place_query: plan.place_resolution.query,
          place_candidate_count: plan.place_resolution.candidate_count,
        }
      : {}),
    ...(plan.recommendations ? { recommendation_count: plan.recommendations.length } : {}),
  };
}

function buildGroupedSummary(
  plan: BcnCityPlanData,
  data: JsonRecord,
  groups: JsonRecord[],
): Record<string, JsonValue> {
  return {
    query: plan.intent.query,
    type: "grouped_counts",
    ...(getString(data.group_by) ? { group_by: getString(data.group_by) } : {}),
    ...(getNumber(data.matched_row_count) !== undefined
      ? { matched_row_count: getNumber(data.matched_row_count) }
      : {}),
    ...(getNumber(data.row_count) !== undefined ? { row_count: getNumber(data.row_count) } : {}),
    groups: groups.slice(0, SUMMARY_ROW_LIMIT).map((group) => ({
      count: getNumber(group.count) ?? 0,
      key: group.key ?? null,
      ...(getNumber(group.min_distance_m) !== undefined
        ? { min_distance_m: Math.round(getNumber(group.min_distance_m) ?? 0) }
        : {}),
    })),
    ...(getPlaceContext(plan) ? { place: getPlaceContext(plan) } : {}),
  };
}

function buildRowSummary(
  plan: BcnCityPlanData,
  data: JsonRecord,
  rows: JsonRecord[],
): Record<string, JsonValue> {
  return {
    query: plan.intent.query,
    ...(getNumber(data.matched_row_count) !== undefined
      ? { matched_row_count: getNumber(data.matched_row_count) }
      : {}),
    ...(getNumber(data.total) !== undefined ? { total: getNumber(data.total) } : {}),
    ...(getNumber(data.row_count) !== undefined ? { row_count: getNumber(data.row_count) } : {}),
    rows: rows.slice(0, SUMMARY_ROW_LIMIT).map(toAnswerRowSummary),
    ...(getPlaceContext(plan) ? { place: getPlaceContext(plan) } : {}),
  };
}

function collectAnswerNotes(
  execution: BcnCityExecuteQueryData,
  finalData: JsonRecord | undefined,
): { caveats: string[]; execution_notes: string[] } {
  const caveats: string[] = [];
  const executionNotes: string[] = [];

  addCaveats(caveats, execution.plan.intent.caveats);
  addRecommendationNotes(execution.plan.recommendation?.caveats, caveats, executionNotes);

  if (execution.plan.place_resolution?.truncated) {
    addCaveat(
      caveats,
      "Place resolution was truncated; additional BCN place candidates may exist.",
    );
  }

  if (!finalData) {
    return { caveats, execution_notes: executionNotes };
  }

  const truncationReason = getString(finalData.truncation_reason);
  const truncationHint = getString(finalData.truncation_hint);

  if (finalData.truncated === true) {
    addCaveat(
      caveats,
      truncationReason
        ? `Final result was truncated because of ${truncationReason}${truncationHint ? `: ${truncationHint}` : "."}`
        : "Final result was truncated.",
    );
  }

  if (finalData.strategy === "download_stream") {
    addCaveat(
      executionNotes,
      "Final query used a bounded BCN-hosted download scan; configured byte and row caps apply.",
    );
  }

  if (finalData.datastore_mode === "sql") {
    addCaveat(
      executionNotes,
      "Spatial narrowing used generated CKAN datastore_search_sql pushdown.",
    );
  }

  if (
    isRecord(finalData.bbox) &&
    execution.plan.intent.spatial_mode === "within" &&
    !finalData.area_filter
  ) {
    addCaveat(
      caveats,
      "Area query used a bbox fallback, so results are based on a rectangular approximation.",
    );
  }

  return { caveats, execution_notes: executionNotes };
}

function getFinalData(finalResult: Record<string, JsonValue> | null): JsonRecord | undefined {
  const data = finalResult?.data;
  return isRecord(data) ? data : undefined;
}

function isEmptyFinalData(data: JsonRecord): boolean {
  const groups = getRecordArray(data.groups);
  const rowCount = getNumber(data.row_count);
  const matchedRowCount = getNumber(data.matched_row_count);
  const total = getNumber(data.total);

  if (groups.length > 0) {
    return false;
  }

  return matchedRowCount === 0 || total === 0 || rowCount === 0;
}

function getMatchedText(data: JsonRecord, suffix?: string): string | undefined {
  const matched =
    getNumber(data.matched_row_count) ?? getNumber(data.total) ?? getNumber(data.row_count);

  if (matched === undefined) {
    return undefined;
  }

  const suffixText = suffix ? ` ${suffix}` : "";
  return `Matched ${formatCount(matched, "row")}${suffixText}.`;
}

function getAreaProvenanceSentence(plan: BcnCityPlanData, data: JsonRecord): string | undefined {
  const place = plan.place_resolution?.selected_candidate;

  if (!place || (!isRecord(data.area_filter) && plan.intent.spatial_mode !== "within")) {
    return undefined;
  }

  const source = place.source_dataset_name ?? "Open Data BCN";
  const rowId = isRecord(data.area_filter) ? data.area_filter.row_id : place.area_ref?.row_id;
  const rowText = rowId === undefined ? "" : ` row ${formatJsonValue(rowId)}`;

  return `Area provenance: ${place.kind} ${place.name} from ${source}${rowText}.`;
}

function getPlaceContext(plan: BcnCityPlanData): Record<string, JsonValue> | undefined {
  const place = plan.place_resolution?.selected_candidate;

  if (!place) {
    return undefined;
  }

  return {
    kind: place.kind,
    name: place.name,
    source_resource_id: place.source_resource_id,
    ...(place.source_dataset_name ? { source_dataset_name: place.source_dataset_name } : {}),
    ...(place.area_ref
      ? {
          area_ref: {
            geometry_field: place.area_ref.geometry_field,
            geometry_type: place.area_ref.geometry_type,
            row_id: place.area_ref.row_id,
            source_resource_id: place.area_ref.source_resource_id,
          },
        }
      : {}),
  };
}

function getSelectedResource(plan: BcnCityPlanData): BcnCityAnswerSelectedResource | undefined {
  if (plan.recommendation) {
    return {
      datastore_active: plan.recommendation.datastore_active,
      format: plan.recommendation.format,
      package_id: plan.recommendation.package_id,
      resource_id: plan.recommendation.resource_id,
      source_url: plan.recommendation.source_url,
      theme: plan.recommendation.theme,
      title: plan.recommendation.title,
    };
  }

  if (plan.resource_override) {
    return {
      datastore_active: plan.resource_override.datastore_active,
      format: plan.resource_override.format,
      package_id: plan.resource_override.package_id,
      resource_id: plan.resource_override.resource_id,
      source_url: plan.resource_override.source_url,
      title: plan.resource_override.name,
    };
  }

  return undefined;
}

function toAnswerRowSummary(row: JsonRecord): Record<string, JsonValue> {
  return {
    label: getRowLabel(row),
    ...(getRowDistance(row) === undefined
      ? {}
      : { distance_m: Math.round(getRowDistance(row) ?? 0) }),
    fields: pickSummaryFields(row),
  };
}

function formatNearestRow(row: JsonRecord): string {
  const distance = getRowDistance(row);
  const label = getRowLabel(row);

  return distance === undefined ? label : `${label} (${Math.round(distance)} m)`;
}

function getRowLabel(row: JsonRecord): string {
  const field = [
    "name",
    "nom",
    "title",
    "titol",
    "institution_name",
    "cat_nom_catala",
    "secondary_filters_name",
    "adreca",
    "addresses_road_name",
    "addresses_neighborhood_name",
    "addresses_district_name",
  ].find((key) => typeof row[key] === "string" && String(row[key]).trim().length > 0);

  if (field) {
    return String(row[field]);
  }

  const fallback = Object.entries(row).find(
    ([key, value]) => !key.startsWith("_") && typeof value === "string" && value.trim().length > 0,
  );

  if (fallback) {
    return String(fallback[1]);
  }

  const rowId = row._id;

  return rowId === undefined || rowId === null ? "row" : String(rowId);
}

function pickSummaryFields(row: JsonRecord): Record<string, JsonValue> {
  const preferred = [
    "name",
    "nom",
    "cat_nom_catala",
    "secondary_filters_name",
    "adreca",
    "addresses_road_name",
    "addresses_neighborhood_name",
    "addresses_district_name",
  ];
  const fields: Record<string, JsonValue> = {};

  for (const key of preferred) {
    if (row[key] !== undefined) {
      fields[key] = row[key];
    }
  }

  if (Object.keys(fields).length > 0) {
    return fields;
  }

  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("_") || isCoordinateField(key)) {
      continue;
    }

    fields[key] = value;

    if (Object.keys(fields).length >= 4) {
      break;
    }
  }

  return fields;
}

function getRowDistance(row: JsonRecord): number | undefined {
  const geo = row._geo;

  if (!isRecord(geo)) {
    return undefined;
  }

  return getNumber(geo.distance_m);
}

function getRecordArray(value: JsonValue | undefined): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatJsonValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "Unknown";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function compactSentences(sentences: Array<string | undefined>): string {
  return sentences.filter((sentence): sentence is string => Boolean(sentence)).join(" ");
}

function addRecommendationNotes(
  recommendationCaveats: string[] | undefined,
  caveats: string[],
  executionNotes: string[],
): void {
  for (const caveat of recommendationCaveats ?? []) {
    addCaveat(isExecutionNote(caveat) ? executionNotes : caveats, caveat);
  }
}

function isExecutionNote(value: string): boolean {
  return /^Not DataStore-active;/u.test(value);
}

function addCaveats(target: string[], caveats: string[] | undefined): void {
  for (const caveat of caveats ?? []) {
    addCaveat(target, caveat);
  }
}

function addCaveat(target: string[], caveat: string): void {
  if (!target.includes(caveat)) {
    target.push(caveat);
  }
}

function isCoordinateField(key: string): boolean {
  return /(?:^|_)(lat|lon|lng|longitud|latitude|longitude)(?:_|$)/iu.test(key);
}
