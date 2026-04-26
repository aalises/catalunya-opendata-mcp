export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function toJsonSafeValue(value: unknown): JsonValue | undefined {
  return normalizeJsonValue(value, new WeakSet<object>());
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const normalizedArray: JsonValue[] = [];

    for (const item of value) {
      const normalized = normalizeJsonValue(item, seen);
      normalizedArray.push(normalized === undefined ? null : normalized);
    }

    seen.delete(value);
    return normalizedArray;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    seen.delete(value);
    return undefined;
  }

  const normalizedObject: Record<string, JsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeJsonValue(item, seen);

    if (normalized !== undefined) {
      normalizedObject[key] = normalized;
    }
  }

  seen.delete(value);
  return normalizedObject;
}
