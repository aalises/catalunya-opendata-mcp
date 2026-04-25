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
  return [
    {
      type: "text",
      text: JSON.stringify(structuredContent),
    },
  ];
}

export function getJsonToolResultByteLength(
  structuredContent: unknown,
  options: JsonToolResultSizingOptions = {},
): number {
  return getJsonByteLength({
    content: createJsonTextContent(structuredContent),
    structuredContent,
    ...(options.isError ? { isError: true } : {}),
  });
}
