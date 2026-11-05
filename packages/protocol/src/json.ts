import { utf8ByteLength } from "./payload.js";

/**
 * File metadata is free-form JSON: no schema, but it must be *JSON* — not
 * arbitrary JavaScript. Limits keep a hostile peer from exhausting the
 * receiver while it validates the offer.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const MAX_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_ARRAY = 256;
const MAX_METADATA_STRING = 4096;
const MAX_METADATA_KEY = 128;

export type JsonNormalization =
  | { ok: true; value: JsonValue; bytes: number }
  | { ok: false; reason: string };

class JsonLimitError extends Error {}

/**
 * Validates and deep-copies a value into plain JSON. Rejects objects with
 * non-plain prototypes, accessors, sparse arrays, non-finite numbers, and
 * anything that is not JSON.
 */
export function normalizeJson(value: unknown, maxBytes = MAX_METADATA_BYTES): JsonNormalization {
  let bytes = 0;

  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maxBytes) {
      throw new JsonLimitError(`metadata exceeds ${maxBytes} bytes`);
    }
  };

  const walk = (input: unknown, depth: number): JsonValue => {
    if (input === null) {
      add(4);
      return null;
    }
    if (typeof input === "string") {
      if (input.length > MAX_METADATA_STRING) {
        throw new JsonLimitError(`metadata string exceeds ${MAX_METADATA_STRING} characters`);
      }
      add(utf8ByteLength(input) + 2);
      return input;
    }
    if (typeof input === "boolean") {
      add(input ? 4 : 5);
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new JsonLimitError("metadata numbers must be finite");
      add(String(input).length);
      return input;
    }
    if (typeof input !== "object") {
      throw new JsonLimitError("metadata must contain only JSON values");
    }
    if (depth >= MAX_METADATA_DEPTH) {
      throw new JsonLimitError(`metadata nesting exceeds ${MAX_METADATA_DEPTH}`);
    }

    if (Array.isArray(input)) {
      if (input.length > MAX_METADATA_ARRAY) {
        throw new JsonLimitError(`metadata arrays are limited to ${MAX_METADATA_ARRAY} entries`);
      }
      add(2);
      const normalized: JsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new JsonLimitError("metadata arrays must not be sparse or accessor-backed");
        }
        if (index > 0) add(1);
        normalized.push(walk(descriptor.value, depth + 1));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonLimitError("metadata objects must be plain objects");
    }

    const keys = Object.keys(input);
    if (keys.length > MAX_METADATA_KEYS) {
      throw new JsonLimitError(`metadata objects are limited to ${MAX_METADATA_KEYS} keys`);
    }

    add(2);
    const normalized: { [key: string]: JsonValue } = {};
    keys.forEach((key, index) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new JsonLimitError(`metadata key "${key}" is not allowed`);
      }
      if (key.length > MAX_METADATA_KEY) {
        throw new JsonLimitError(`metadata keys are limited to ${MAX_METADATA_KEY} characters`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new JsonLimitError("metadata objects must not contain accessors");
      }
      if (index > 0) add(1);
      add(utf8ByteLength(key) + 3);
      normalized[key] = walk(descriptor.value, depth + 1);
    });
    return normalized;
  };

  try {
    const normalized = walk(value, 0);
    return { ok: true, value: normalized, bytes };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "metadata is not valid JSON",
    };
  }
}

/** Stable serialization: object keys sorted, no whitespace. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}
