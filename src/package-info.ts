import { readFileSync } from "node:fs";
import { z } from "zod";

const packageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

// Resolves package.json next to dist/ at runtime. If we ever bundle dist with a tool
// that flattens import.meta.url, switch to `import pkg from "../package.json" with { type: "json" }`.
const packageJson = packageJsonSchema.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);

export const packageName = packageJson.name;
export const packageVersion = packageJson.version;
