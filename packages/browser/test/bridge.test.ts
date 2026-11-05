import { describe, expect, it } from "vitest";
import { CdepException } from "@cdep/protocol";
import {
  CSV_V1,
  NEWICK_V1,
  normalizeFormatKey,
  registryCapability,
} from "@cdep/formats";
import { createBridge } from "../src/bridge.js";

const capabilitiesOf = (bridge: ReturnType<typeof createBridge>) => bridge.capabilities;

describe("createBridge", () => {
  it("builds capabilities from alias keys without registry knowledge", () => {
    const bridge = createBridge({
      application: { name: "Sequence App" },
      normalizeFormatKey,
      exports: {
        newick: () => ({ data: "(A,B);" }),
        fasta: () => ({ data: ">a\nACGT\n" }),
      },
      imports: { fasta: () => undefined },
    });

    expect(bridge.capabilities.protocol).toBe("cdep");
    expect(bridge.capabilities.application).toEqual({ name: "Sequence App" });
    expect(bridge.capabilities.exports.map((capability) => capability.id).sort()).toEqual([
      "org.cdep.format.fasta.v1",
      "org.cdep.format.newick.v1",
    ]);
    expect(bridge.capabilities.imports.map((capability) => capability.id)).toEqual([
      "org.cdep.format.fasta.v1",
    ]);
  });

  it("merges capability hints and applies the global ceiling", () => {
    const bridge = createBridge({
      application: { name: "Tree Viewer" },
      maxBytes: 2048,
      exports: { "org.cdep.format.newick.v1": () => ({ data: "(A,B);" }) },
      importCapabilities: {
        [NEWICK_V1]: { label: "Newick", extensions: [".nwk"], maxBytes: 512 },
      },
      imports: { [NEWICK_V1]: () => undefined },
    });

    const imported = bridge.capabilities.imports[0];
    expect(imported).toMatchObject({ id: NEWICK_V1, label: "Newick", maxBytes: 512 });
    expect(bridge.capabilities.exports[0]?.maxBytes).toBe(2048);
  });

  it("keeps registry-derived capabilities usable as hints", () => {
    const bridge = createBridge({
      application: { name: "Tree Viewer" },
      imports: { [NEWICK_V1]: () => undefined },
      importCapabilities: { [NEWICK_V1]: registryCapability(NEWICK_V1) },
    });
    expect(bridge.capabilities.imports[0]).toMatchObject({
      id: NEWICK_V1,
      label: "Newick",
      mediaTypes: ["text/plain"],
    });
  });

  it("rejects two adapters that normalize to the same identifier", () => {
    expect(() =>
      createBridge({
        application: { name: "Dup" },
        normalizeFormatKey,
        exports: {
          newick: () => ({ data: "" }),
          [NEWICK_V1]: () => ({ data: "" }),
        },
      }),
    ).toThrow(CdepException);
  });

  it("rejects an empty application name", () => {
    expect(() => createBridge({ application: { name: "" } })).toThrow(CdepException);
  });

  it("exposes the CSV identifier without inventing a schema", () => {
    const bridge = createBridge({
      application: { name: "Tabular" },
      imports: { csv: () => undefined },
      normalizeFormatKey,
    });
    expect(bridge.capabilities.imports[0]?.id).toBe(CSV_V1);
    expect(bridge.capabilities.imports[0]?.schema).toBeUndefined();
  });

  it("refuses a plain-HTTP public destination before opening a window", async () => {
    const bridge = createBridge({
      application: { name: "Sender" },
      normalizeFormatKey,
      exports: { newick: () => ({ data: "(A,B);" }) },
    });
    await expect(bridge.sendTo("http://treeviewer.example")).rejects.toMatchObject({
      code: "HTTPS_REQUIRED",
    });
    expect(bridge.receiver).toBeUndefined();
    expect(capabilitiesOf(bridge).exports).toHaveLength(1);
  });
});
