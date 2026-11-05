import { describe, expect, it } from "vitest";
import {
  validateCapabilities,
  type Capabilities,
} from "../src/index.js";

const valid: Capabilities = {
  protocol: "cdep",
  version: 1,
  application: { name: "Tree Viewer", url: "https://treeviewer.example" },
  imports: [
    {
      id: "org.cdep.format.newick.v1",
      label: "Newick",
      mediaTypes: ["text/plain"],
      extensions: [".nwk", ".newick"],
      maxBytes: 10_485_760,
    },
  ],
  exports: [],
};

describe("validateCapabilities", () => {
  it("accepts a well-formed payload", () => {
    const result = validateCapabilities(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imports[0]?.id).toBe("org.cdep.format.newick.v1");
      expect(result.value.imports[0]?.maxBytes).toBe(10_485_760);
    }
  });

  it("rejects the wrong protocol without a generic validation error", () => {
    const result = validateCapabilities({ ...valid, protocol: "other" });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PROTOCOL_MISMATCH" }),
    });
  });

  it("rejects an unsupported version and reports both versions", () => {
    const result = validateCapabilities({ ...valid, version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VERSION_UNSUPPORTED");
      expect(result.error.details).toMatchObject({ received: 2, supported: 1 });
    }
  });

  it.each([
    ["bare extension as id", { id: ".nwk" }],
    ["uppercase id", { id: "org.cdep.format.Newick.v1" }],
    ["unversioned single segment", { id: "newick" }],
    ["empty id", { id: "" }],
  ])("rejects %s", (_name, patch) => {
    const result = validateCapabilities({
      ...valid,
      imports: [{ ...valid.imports[0], ...patch }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITIES_INVALID");
  });

  it("rejects duplicate identifiers in one direction", () => {
    const result = validateCapabilities({
      ...valid,
      imports: [valid.imports[0], valid.imports[0]],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "imports[1].id" })]),
      );
    }
  });

  it("rejects a zero byte ceiling", () => {
    const result = validateCapabilities({
      ...valid,
      imports: [{ id: "org.cdep.format.newick.v1", maxBytes: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects capability lists that are not arrays", () => {
    const result = validateCapabilities({ ...valid, exports: "none" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CAPABILITIES_INVALID");
  });

  it("rejects a missing application name", () => {
    const result = validateCapabilities({ ...valid, application: { name: "" } });
    expect(result.ok).toBe(false);
  });

  it("drops unknown extra properties rather than forwarding them", () => {
    const result = validateCapabilities({
      ...valid,
      imports: [{ ...valid.imports[0], smuggled: "<script>" }],
      extra: { nested: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imports[0]).not.toHaveProperty("smuggled");
      expect(result.value).not.toHaveProperty("extra");
    }
  });
});
