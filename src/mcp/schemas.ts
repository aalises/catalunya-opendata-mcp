import { z } from "zod";

import type { JsonValue } from "../sources/common/json-safe.js";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(jsonValueSchema);
