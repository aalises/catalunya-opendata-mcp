import type { z } from "zod";

export function formatZodError(error: z.ZodError, rootName = "response"): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || rootName}: ${issue.message}`)
    .join("; ");
}
