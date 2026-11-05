import { describe, expect, it } from "vitest";
import { isFormatId } from "@cdep/protocol";
import {
  AUSPICE_V2,
  CSV_V1,
  FASTA_V1,
  FORMAT_REGISTRY,
  formatDefinition,
  NEXUS_V1,
  NEWICK_V1,
  normalizeFormatKey,
  REGISTRY_BY_ALIAS,
  registryCapability,
  TIP_METADATA_SCHEMA_V1,
} from "../src/index.js";

describe("format registry", () => {
  it.each(FORMAT_REGISTRY)("$id is a valid CDEP format identifier", (definition) => {
    expect(isFormatId(definition.id)).toBe(true);
  });

  it("has no duplicate identifiers or aliases", () => {
    expect(new Set(FORMAT_REGISTRY.map((definition) => definition.id)).size).toBe(
      FORMAT_REGISTRY.length,
    );
    expect(REGISTRY_BY_ALIAS.size).toBe(FORMAT_REGISTRY.length);
  });

  it("declares schema ids that are valid identifiers", () => {
    expect(isFormatId(TIP_METADATA_SCHEMA_V1)).toBe(true);
  });

  it("exposes the five v0.1 identifiers", () => {
    expect([NEWICK_V1, FASTA_V1, CSV_V1, NEXUS_V1, AUSPICE_V2].sort()).toEqual(
      FORMAT_REGISTRY.map((definition) => definition.id).sort(),
    );
  });

  it("looks definitions up by full identifier only", () => {
    expect(formatDefinition(NEWICK_V1)?.label).toBe("Newick");
    expect(formatDefinition("newick")).toBeUndefined();
  });
});

describe("normalizeFormatKey", () => {
  it.each([
    ["newick", NEWICK_V1],
    ["fasta", FASTA_V1],
    ["csv", CSV_V1],
    ["nexus", NEXUS_V1],
    ["auspice", AUSPICE_V2],
    [NEWICK_V1, NEWICK_V1],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeFormatKey(input)).toBe(expected);
  });

  it("leaves unknown identifiers untouched", () => {
    expect(normalizeFormatKey("org.example.format.custom.v1")).toBe(
      "org.example.format.custom.v1",
    );
  });
});

describe("registryCapability", () => {
  it("pre-fills label, media types and extensions", () => {
    const capability = registryCapability(NEWICK_V1);
    expect(capability).toMatchObject({
      id: NEWICK_V1,
      label: "Newick",
      mediaTypes: ["text/plain"],
      extensions: [".nwk", ".newick", ".tree"],
    });
  });

  it("lets the application narrow the declaration", () => {
    const capability = registryCapability(NEWICK_V1, { maxBytes: 1024 });
    expect(capability.maxBytes).toBe(1024);
    expect(capability.label).toBe("Newick");
  });

  it("passes unknown identifiers through with overrides only", () => {
    expect(registryCapability("org.example.format.custom.v1")).toEqual({
      id: "org.example.format.custom.v1",
    });
  });
});
