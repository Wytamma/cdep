import { describe, expect, it } from "vitest";
import {
  CdepException,
  isCdepError,
  payloadByteLength,
  toTransferableBuffer,
  unwrap,
  utf8ByteLength,
  failedResult,
} from "../src/index.js";

describe("utf8ByteLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["水", 3],
    ["🧬", 4],
    ["a🧬b", 6],
    ["\ud800", 3],
    ["\udc00", 3],
  ])("matches TextEncoder for %j", (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
  });

  it("computes the length of a large string without encoding it", () => {
    const value = "ACGT".repeat(250_000);
    expect(utf8ByteLength(value)).toBe(1_000_000);
  });
});

describe("payloadByteLength", () => {
  it("measures strings in UTF-8 bytes, not UTF-16 units", () => {
    expect(payloadByteLength("é")).toBe(2);
    expect(payloadByteLength("🧬")).toBe(4);
  });

  it("measures buffers directly", () => {
    expect(payloadByteLength(new ArrayBuffer(7))).toBe(7);
  });
});

describe("toTransferableBuffer", () => {
  it("copies whole buffers so the exporter keeps ownership", () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);

    const result = toTransferableBuffer(new Uint8Array(buffer));
    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect(result.data).not.toBe(buffer);
    expect(result.buffer).toBe(result.data);
    expect([...new Uint8Array(result.data as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
  });

  it("copies a partial view so out-of-range bytes never travel", () => {
    const backing = new ArrayBuffer(8);
    new Uint8Array(backing).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = new Uint8Array(backing, 2, 4);

    const result = toTransferableBuffer(view);
    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect((result.data as ArrayBuffer).byteLength).toBe(4);
    expect([...new Uint8Array(result.data as ArrayBuffer)]).toEqual([3, 4, 5, 6]);
    expect(result.data).not.toBe(backing);
  });

  it("keeps strings as strings", () => {
    expect(toTransferableBuffer("(A,B);")).toEqual({ data: "(A,B);" });
  });
});

describe("errors", () => {
  it("throws CdepException carrying the code and details", () => {
    const result = failedResult({ code: "SIZE_EXCEEDED", message: "too big", details: { maxBytes: 1 } }, "SIZE_EXCEEDED");
    try {
      unwrap(result);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CdepException);
      const exception = error as CdepException;
      expect(exception.code).toBe("SIZE_EXCEEDED");
      expect(exception.toJSON()).toEqual({
        code: "SIZE_EXCEEDED",
        message: "too big",
        details: { maxBytes: 1 },
      });
    }
  });

  it("recognizes only known error codes", () => {
    expect(isCdepError({ code: "REJECTED", message: "no" })).toBe(true);
    expect(isCdepError({ code: "NOT_A_CDEP_CODE", message: "no" })).toBe(false);
    expect(isCdepError({ code: "REJECTED" })).toBe(false);
    expect(isCdepError("REJECTED")).toBe(false);
  });

  it("maps arbitrary failures to a fallback code", () => {
    expect(failedResult(new Error("boom"))).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "boom" },
    });
    expect(failedResult(new Error("parse"), "IMPORT_FAILED")).toEqual({
      ok: false,
      error: { code: "IMPORT_FAILED", message: "parse" },
    });
  });
});
