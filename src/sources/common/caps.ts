import { toJsonSafeValue } from "./json-safe.js";

export interface JsonToolResultSizingOptions {
  isError?: boolean;
}

export function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function getJsonByteLength(value: unknown): number {
  return getUtf8ByteLength(JSON.stringify(value));
}

export function getUrlByteLength(url: URL): number {
  return getUtf8ByteLength(url.toString());
}

export function createJsonTextContent(structuredContent: unknown): Array<{
  type: "text";
  text: string;
}> {
  const safeStructuredContent = toJsonSafeValue(structuredContent) ?? null;

  return [
    {
      type: "text",
      text: JSON.stringify(safeStructuredContent),
    },
  ];
}

export function getJsonToolResultByteLength(
  structuredContent: unknown,
  options: JsonToolResultSizingOptions = {},
): number {
  const safeStructuredContent = toJsonSafeValue(structuredContent) ?? null;

  return getJsonByteLength({
    content: createJsonTextContent(safeStructuredContent),
    structuredContent: safeStructuredContent,
    ...(options.isError ? { isError: true } : {}),
  });
}
