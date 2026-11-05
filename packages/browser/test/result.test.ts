import { describe, expect, it } from "vitest";
import { ok, validateCapabilities, type Result } from "@cdep/protocol";
import { readRemoteResult, toTransportError } from "../src/result.js";

const capabilities = {
  protocol: "cdep" as const,
  version: 3 as const,
  application: { name: "Tree Viewer" },
  imports: [{ id: "org.cdep.format.newick.v1" }],
  exports: [],
};

describe("readRemoteResult", () => {
  it("accepts a valid success envelope", () => {
    const result = readRemoteResult({ ok: true, value: capabilities }, validateCapabilities, "test");
    expect(result.ok).toBe(true);
  });

  it("preserves a well-formed remote CDEP error", () => {
    const result = readRemoteResult(
      { ok: false, error: { code: "SIZE_EXCEEDED", message: "too big", details: { maxBytes: 1 } } },
      validateCapabilities,
      "test",
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "SIZE_EXCEEDED", message: "too big", details: { maxBytes: 1 } },
    });
  });

  it.each([
    ["null", null],
    ["a bare value", "ok"],
    ["a missing ok flag", { value: capabilities }],
    ["a non-boolean ok flag", { ok: "yes", value: capabilities }],
    ["an unknown error code", { ok: false, error: { code: "SOMETHING", message: "x" } }],
    ["a non-object error", { ok: false, error: "x" }],
  ])("rejects %s", (_name, value) => {
    const result = readRemoteResult(value, validateCapabilities, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL");
  });

  it("re-validates a success payload from a hostile peer", () => {
    const validator = (value: unknown): Result<{ safe: true }> => {
      const safe =
        typeof value === "object" && value !== null && "safe" in value ? value.safe : undefined;
      return safe === true
        ? ok({ safe: true })
        : { ok: false, error: { code: "CAPABILITIES_INVALID", message: "bad payload" } };
    };
    const result = readRemoteResult({ ok: true, value: { safe: false } }, validator, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITIES_INVALID");
  });
});

describe("toTransportError", () => {
  const penpalError = (code: string): Error => Object.assign(new Error("failure"), { code });

  it.each([
    ["CONNECTION_TIMEOUT", "TIMED_OUT"],
    ["METHOD_CALL_TIMEOUT", "TIMED_OUT"],
    ["CONNECTION_DESTROYED", "CANCELLED"],
    ["METHOD_NOT_FOUND", "HANDSHAKE_FAILED"],
    ["TRANSMISSION_FAILED", "HANDSHAKE_FAILED"],
  ])("maps Penpal's %s to %s", (penpalCode, cdepCode) => {
    expect(toTransportError(penpalError(penpalCode), "ctx").code).toBe(cdepCode);
  });

  it("keeps CDEP errors intact", () => {
    expect(toTransportError({ code: "REJECTED", message: "declined" }, "test")).toEqual({
      code: "REJECTED",
      message: "declined",
    });
  });
});
