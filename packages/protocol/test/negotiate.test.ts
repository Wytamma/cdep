import { describe, expect, it } from "vitest";
import {
  negotiate,
  selectMatch,
  type FormatCapability,
} from "../src/index.js";

const NEWICK = "org.cdep.format.newick.v1";
const FASTA = "org.cdep.format.fasta.v1";
const CSV = "org.cdep.format.csv.v1";

const exporter = (id: string, extra: Partial<FormatCapability> = {}): FormatCapability => ({
  id,
  ...extra,
});
const importer = (id: string, extra: Partial<FormatCapability> = {}): FormatCapability => ({
  id,
  ...extra,
});

describe("negotiate", () => {
  it("matches only byte-identical identifiers", () => {
    const result = negotiate([{ id: NEWICK, extensions: [".nwk"] }], [
      { id: NEWICK, mediaTypes: ["text/plain"] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((match) => match.formatId)).toEqual([NEWICK]);
  });

  it("does not match on shared media type or extension", () => {
    const result = negotiate(
      [{ id: NEWICK, mediaTypes: ["text/plain"], extensions: [".nwk"] }],
      [{ id: FASTA, mediaTypes: ["text/plain"], extensions: [".nwk"] }],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("requires identical schemas when either side declares one", () => {
    const schema = { id: "org.cdep.schema.metadata.v1", version: 1 };
    const matched = negotiate(
      [{ id: CSV, schema }],
      [{ id: CSV, schema: { ...schema } }],
    );
    expect(matched.ok && matched.value).toHaveLength(1);

    const mismatchedVersion = negotiate(
      [{ id: CSV, schema }],
      [{ id: CSV, schema: { id: schema.id, version: 2 } }],
    );
    expect(mismatchedVersion.ok && mismatchedVersion.value).toEqual([]);

    const oneSided = negotiate([{ id: CSV, schema }], [{ id: CSV }]);
    expect(oneSided.ok && oneSided.value).toEqual([]);
  });

  it("rejects a requested format the receiver does not accept", () => {
    const result = negotiate([{ id: FASTA }], [{ id: NEWICK }], { requestedFormat: FASTA });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_COMMON_FORMAT");
      expect(result.error.details).toMatchObject({ requested: FASTA });
    }
  });

  it("enforces the lower of the two declared ceilings", () => {
    const result = negotiate(
      [{ id: NEWICK, maxBytes: 1000 }],
      [{ id: NEWICK, maxBytes: 500 }],
      { requestedFormat: NEWICK, sizeBytes: 900 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
      expect(result.error.details).toMatchObject({ maxBytes: 500, sizeBytes: 900 });
    }
  });

  it("drops candidates too small for the payload when other formats fit", () => {
    const result = negotiate(
      [
        { id: CSV, maxBytes: 100 },
        { id: NEWICK, maxBytes: 10_000 },
      ],
      [{ id: CSV }, { id: NEWICK }],
      { sizeBytes: 5000 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((match) => match.formatId)).toEqual([NEWICK]);
  });

  it("reports SIZE_EXCEEDED when nothing fits", () => {
    const result = negotiate(
      [{ id: CSV, maxBytes: 100 }],
      [{ id: CSV, maxBytes: 50 }],
      { sizeBytes: 5000 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SIZE_EXCEEDED");
  });

  it("returns candidates in deterministic order", () => {
    const result = negotiate([{ id: NEWICK }, { id: CSV }], [{ id: CSV }, { id: NEWICK }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((match) => match.formatId)).toEqual([CSV, NEWICK]);
    }
  });
});

describe("selectMatch", () => {
  const match = (id: string) => ({
    formatId: id,
    exportCapability: { id },
    importCapability: { id },
  });

  it("fails with NO_COMMON_FORMAT when empty", () => {
    const result = selectMatch([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("refuses to guess between multiple formats", () => {
    const result = selectMatch([match(CSV), match(NEWICK)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AMBIGUOUS_FORMAT");
      expect(result.error.details?.candidates).toEqual([CSV, NEWICK]);
    }
  });

  it("returns the single match", () => {
    const result = selectMatch([match(NEWICK)]);
    expect(result.ok && result.value.formatId).toBe(NEWICK);
  });
});
