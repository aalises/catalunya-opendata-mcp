import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { jsonObjectSchema, jsonValueSchema } from "../../src/mcp/schemas.js";
import {
  answerCityQueryDataSchema,
  cityAnswerSelectionOptionSchema,
} from "../../src/mcp/tools/bcn-city-schemas.js";
import { answerBcnCityQuery } from "../../src/sources/bcn/city-answer.js";
import {
  baseConfig,
  bcnResource,
  ckanSuccess,
  mockFetchResponses,
  mustFindBcnPlaceRegistryResource,
  resetBcnPlaceRegistry,
  setBcnPlaceRegistry,
  smallPolygon,
} from "../sources/bcn/helpers.js";

const DISTRICT_PLACE_RESOURCE = mustFindBcnPlaceRegistryResource(
  "576bc645-9481-4bc4-b8bf-f5972c20df3f",
);

const summaryGroupSchema = z
  .object({
    count: z.number().int().nonnegative(),
    key: jsonValueSchema,
    min_distance_m: z.number().nonnegative().optional(),
  })
  .passthrough();

const summaryRowSchema = z
  .object({
    distance_m: z.number().nonnegative().optional(),
    fields: jsonObjectSchema,
    label: z.string(),
    source_row: jsonObjectSchema,
  })
  .passthrough();

const mapPointSchema = z
  .object({
    distance_m: z.number().nonnegative().optional(),
    label: z.string(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    source_row: jsonObjectSchema,
  })
  .passthrough();

const summarySchema = z
  .object({
    groups: z.array(summaryGroupSchema).optional(),
    map_points: z.array(mapPointSchema).optional(),
    rows: z.array(summaryRowSchema).optional(),
  })
  .passthrough();

const selectionOptionsContractSchema = z
  .object({
    options: z.array(cityAnswerSelectionOptionSchema.passthrough()).min(1),
    selection_type: z.enum(["place", "resource"]),
  })
  .passthrough();

const bcnAnswerClientContractSchema = answerCityQueryDataSchema
  .extend({
    answer_markdown: z.string().min(1),
    answer_text: z.string().min(1),
    selection_options: selectionOptionsContractSchema.optional(),
    summary: summarySchema,
  })
  .passthrough()
  .superRefine((answer, context) => {
    if (answer.answer_type === "blocked") {
      expectContract(
        answer.execution_status === "blocked",
        context,
        ["execution_status"],
        "blocked answers must have execution_status=blocked",
      );
      expectContract(
        answer.final_result === null,
        context,
        ["final_result"],
        "blocked answers must not fabricate final_result",
      );
    }

    if (answer.answer_type === "grouped_counts") {
      expectContract(
        answer.execution_status === "completed",
        context,
        ["execution_status"],
        "grouped answers must be completed",
      );
      expectContract(
        Array.isArray(answer.summary.groups) && answer.summary.groups.length > 0,
        context,
        ["summary", "groups"],
        "grouped answers must expose summary.groups",
      );
      expectContract(
        answer.final_result !== null,
        context,
        ["final_result"],
        "completed grouped answers must preserve final_result",
      );
    }

    if (answer.answer_type === "nearest_rows") {
      expectContract(
        answer.execution_status === "completed",
        context,
        ["execution_status"],
        "nearest answers must be completed",
      );
      expectContract(
        Array.isArray(answer.summary.rows) && answer.summary.rows.length > 0,
        context,
        ["summary", "rows"],
        "nearest answers must expose summary.rows",
      );
      expectContract(
        Array.isArray(answer.summary.map_points) && answer.summary.map_points.length > 0,
        context,
        ["summary", "map_points"],
        "nearest answers must expose map-ready summary.map_points",
      );
      expectContract(
        answer.final_result !== null,
        context,
        ["final_result"],
        "completed nearest answers must preserve final_result",
      );
    }

    if (answer.answer_type === "empty_result") {
      expectContract(
        answer.execution_status === "completed",
        context,
        ["execution_status"],
        "empty answers must be completed",
      );
      expectContract(
        Array.isArray(answer.summary.rows),
        context,
        ["summary", "rows"],
        "empty answers must expose summary.rows as an array",
      );
      expectContract(
        answer.final_result !== null,
        context,
        ["final_result"],
        "completed empty answers must preserve final_result",
      );
    }
  });

describe("BCN answer client contract", () => {
  afterEach(() => {
    resetBcnPlaceRegistry();
    vi.restoreAllMocks();
  });

  it("publishes a machine-readable schema for client implementers", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../docs/contracts/bcn-answer-city-query.schema.json", import.meta.url),
        "utf8",
      ),
    );

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "bcn_answer_city_query client contract",
      properties: {
        answer_markdown: { type: "string" },
        answer_text: { type: "string" },
        answer_type: {
          enum: expect.arrayContaining([
            "blocked",
            "empty_result",
            "grouped_counts",
            "nearest_rows",
          ]),
        },
        selection_options: { $ref: "#/$defs/selection_options" },
        summary: { $ref: "#/$defs/summary" },
      },
    });
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "answer_markdown",
        "answer_text",
        "answer_type",
        "caveats",
        "execution_status",
        "final_result",
        "summary",
      ]),
    );
    expect(schema.$defs.summary_row.required).toEqual(
      expect.arrayContaining(["fields", "label", "source_row"]),
    );
    expect(schema.$defs.map_point.required).toEqual(
      expect.arrayContaining(["label", "lat", "lon", "source_row"]),
    );
  });

  it("validates replayed grouped, nearest, blocked, and empty golden answers", () => {
    const answers = loadRecordedBcnAnswerData();

    expect(answers.map((answer) => answer.answer_type)).toEqual(
      expect.arrayContaining(["blocked", "empty_result", "grouped_counts", "nearest_rows"]),
    );

    for (const answer of answers) {
      expect(() => bcnAnswerClientContractSchema.parse(answer)).not.toThrow();
    }

    const grouped = mustFindAnswer(answers, "grouped_counts");
    expect(grouped.summary.groups?.[0]).toMatchObject({
      count: expect.any(Number),
      key: expect.any(String),
    });
    expect(grouped.caveats.some((caveat) => caveat.includes("scan_cap"))).toBe(true);

    const nearest = mustFindAnswer(answers, "nearest_rows");
    expect(nearest.summary.rows?.[0]).toMatchObject({
      label: expect.any(String),
      source_row: expect.objectContaining({
        _geo: expect.objectContaining({
          lat: expect.any(Number),
          lon: expect.any(Number),
        }),
      }),
    });
    expect(nearest.summary.map_points?.[0]).toMatchObject({
      lat: expect.any(Number),
      lon: expect.any(Number),
      source_row: expect.any(Object),
    });

    const blocked = mustFindAnswer(answers, "blocked");
    expect(blocked).toMatchObject({
      execution_status: "blocked",
      final_result: null,
      selection_options: {
        selection_type: "place",
        options: expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(/^place:/u),
            label: expect.any(String),
            provenance: expect.any(Object),
            resume_arguments: expect.any(Object),
          }),
        ]),
      },
    });

    const empty = mustFindAnswer(answers, "empty_result");
    expect(empty).toMatchObject({
      execution_status: "completed",
      final_result: expect.any(Object),
      summary: {
        rows: [],
      },
    });
  });

  it("validates the bbox fallback warning contract", async () => {
    setBcnPlaceRegistry([DISTRICT_PLACE_RESOURCE]);
    mockFetchResponses(
      placeResponse([{ nom_districte: "Gràcia", geometria_wgs84: smallPolygon() }]),
      ckanSuccess(
        bcnResource({
          id: "d4803f9b-5f01-48d5-aeef-4ebbd76c5fd7",
          datastore_active: true,
          format: "DataStore",
        }),
      ),
      datastoreFieldsResponse([
        "name",
        "secondary_filters_name",
        "addresses_road_name",
        "addresses_neighborhood_name",
        "addresses_district_name",
        "geo_epgs_4326_lat",
        "geo_epgs_4326_lon",
      ]),
      ckanSuccess({
        records: [],
      }),
    );

    const result = await answerBcnCityQuery(
      {
        query: "facilities in Gracia",
        place_kind: "district",
        limit: 5,
      },
      baseConfig,
    );

    expect(() => bcnAnswerClientContractSchema.parse(result.data)).not.toThrow();
    expect(result.data).toMatchObject({
      answer_type: "empty_result",
      execution_status: "completed",
      final_arguments: {
        bbox: expect.objectContaining({
          max_lat: expect.any(Number),
          max_lon: expect.any(Number),
          min_lat: expect.any(Number),
          min_lon: expect.any(Number),
        }),
      },
    });
    expect(result.data.caveats).toEqual(
      expect.arrayContaining([
        "Area candidate did not expose an area_ref; using its bbox as an approximate rectangular fallback.",
        "Area query used a bbox fallback, so results are based on a rectangular approximation.",
      ]),
    );
  });
});

type ContractAnswer = z.infer<typeof bcnAnswerClientContractSchema>;

function expectContract(
  condition: boolean,
  context: z.RefinementCtx,
  path: (number | string)[],
  message: string,
): void {
  if (condition) {
    return;
  }

  context.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path,
  });
}

function loadRecordedBcnAnswerData(): ContractAnswer[] {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/evals/stress.json", import.meta.url), "utf8"),
  );
  const interactions = Array.isArray(fixture.interactions) ? fixture.interactions : [];

  return interactions
    .filter(
      (interaction: RecordedInteraction) =>
        interaction.method === "callTool" && interaction.params?.name === "bcn_answer_city_query",
    )
    .map((interaction: RecordedInteraction) => interaction.result?.structuredContent?.data);
}

function mustFindAnswer(answers: ContractAnswer[], answerType: ContractAnswer["answer_type"]) {
  const answer = answers.find((candidate) => candidate.answer_type === answerType);

  if (answer === undefined) {
    throw new Error(`Missing recorded ${answerType} answer.`);
  }

  return answer;
}

function placeResponse(records: Record<string, unknown>[]): Response {
  return ckanSuccess({
    records,
  });
}

function datastoreFieldsResponse(fieldNames: string[]): Response {
  return ckanSuccess({
    fields: fieldNames.map((id) => ({ id, type: "text" })),
    records: [],
  });
}

interface RecordedInteraction {
  method?: string;
  params?: {
    name?: string;
  };
  result?: {
    structuredContent?: {
      data?: ContractAnswer;
    };
  };
}
