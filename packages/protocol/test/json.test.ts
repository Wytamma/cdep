import { describe, expect, it } from "vitest";
import {
  MAX_METADATA_BYTES,
  canonicalJson,
  jsonEquals,
  normalizeJson,
} from "../src/index.js";

describe("normalizeJson", () => {
  it("accepts nested JSON and deep-copies it", () => {
    const input = { source: "seq", tips: [1, 2, { label: "x" }], ok: true, none: null };
    const result = normalizeJson(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(result.value).not.toBe(input);
    }
  });

  it("accepts primitives", () => {
    for (const value of [null, true, false, 0, -1.5, "text", []]) {
      expect(normalizeJson(value).ok).toBe(true);
    }
  });

  it("treats an explicitly undefined metadata as a value and rejects it", () => {
    expect(normalizeJson(undefined).ok).toBe(false);
  });

  it.each([
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date(0)],
    ["a class instance", new (class Example {})()],
    ["a Map", new Map()],
    ["a sparse array", [1, , 3]],
    ["an accessor", Object.defineProperty({}, "x", { get: () => 1, enumerable: true })],
    ["a prototype key", JSON.parse('{"__proto__":{"polluted":true}}')],
  ])("rejects %s", (_name, value) => {
    const result = normalizeJson(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("rejects excessive nesting", () => {
    let value: unknown = null;
    for (let index = 0; index < 9; index += 1) value = [value];
    expect(normalizeJson(value).ok).toBe(false);
  });

  it("rejects too many object keys", () => {
    const value = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`k${index}`, index]),
    );
    expect(normalizeJson(value).ok).toBe(false);
  });

  it("rejects oversized arrays", () => {
    expect(normalizeJson(Array.from({ length: 257 }, () => 0)).ok).toBe(false);
  });

  it("rejects oversized strings", () => {
    expect(normalizeJson("x".repeat(4097)).ok).toBe(false);
  });

  it("enforces the byte budget", () => {
    const chunk = "x".repeat(4096);
    const result = normalizeJson([chunk, chunk, chunk, chunk]);
    expect(result.ok).toBe(false);
  });

  it("reports the canonical size", () => {
    const result = normalizeJson({ a: 1, b: "text" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toBeLessThan(MAX_METADATA_BYTES);
      expect(result.bytes).toBe(canonicalJson(result.value).length);
    }
  });
});

describe("canonicalJson / jsonEquals", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(jsonEquals({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
  });

  it("distinguishes values and array order", () => {
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("treats absent metadata as equal only when both are absent", () => {
    expect(jsonEquals(undefined, undefined)).toBe(true);
    expect(jsonEquals(undefined, null)).toBe(false);
    expect(jsonEquals({}, undefined)).toBe(false);
  });
});
