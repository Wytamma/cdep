import { describe, expect, it } from "vitest";
import type { FormatCapability } from "../src/index.js";
import { checkBundle } from "../src/index.js";

const NEWICK = "org.cdep.format.newick.v1";
const CSV = "org.cdep.format.csv.v1";

const capabilities: FormatCapability[] = [
  { id: NEWICK, maxBytes: 512, maxFiles: 2, maxFileBytes: 300 },
  { id: CSV, maxBytes: 1024, maxFiles: 4, maxFileBytes: 500 },
];

const file = (name: string, formatId: string, sizeBytes: number) => ({
  name,
  formatId,
  sizeBytes,
});

describe("checkBundle", () => {
  it("accepts a well-formed single-format bundle", () => {
    const result = checkBundle([file("tree.nwk", NEWICK, 100)], {
      capabilities,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalBytes).toBe(100);
      expect(result.value.formats).toEqual([NEWICK]);
    }
  });

  it("accepts mixed formats", () => {
    const result = checkBundle(
      [file("tree.nwk", NEWICK, 100), file("metadata.csv", CSV, 50)],
      { capabilities, maxBytes: 1024 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.formats).toEqual([NEWICK, CSV]);
      expect(result.value.bytesByFormat.get(CSV)).toBe(50);
    }
  });

  it("rejects an unknown format", () => {
    const result = checkBundle([file("tree.bin", "org.cdep.format.bin.v1", 10)], {
      capabilities,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("rejects a schema mismatch", () => {
    const result = checkBundle(
      [
        {
          ...file("metadata.csv", CSV, 10),
          schema: { id: "org.cdep.schema.other.v1", version: 1 },
        },
      ],
      {
        capabilities: [
          { id: CSV, schema: { id: "org.cdep.schema.tip-metadata.v1", version: 1 } },
        ],
        maxBytes: 1024,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCHEMA_MISMATCH");
  });

  it("enforces the per-file ceiling", () => {
    const result = checkBundle([file("tree.nwk", NEWICK, 301)], {
      capabilities,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
      expect(result.error.details).toMatchObject({ file: "tree.nwk", maxBytes: 300 });
    }
  });

  it("enforces the per-format cumulative ceiling", () => {
    const result = checkBundle(
      [file("a.nwk", NEWICK, 300), file("b.nwk", NEWICK, 300)],
      { capabilities, maxBytes: 2048 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
      expect(result.error.details).toMatchObject({ formatId: NEWICK });
    }
  });

  it("enforces the per-format file count", () => {
    const result = checkBundle(
      [
        file("a.csv", CSV, 10),
        file("b.csv", CSV, 10),
        file("c.csv", CSV, 10),
        file("d.csv", CSV, 10),
        file("e.csv", CSV, 10),
      ],
      { capabilities, maxBytes: 2048 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_COUNT_EXCEEDED");
  });

  it("enforces the global total", () => {
    const result = checkBundle(
      [file("a.nwk", NEWICK, 200), file("b.csv", CSV, 300)],
      { capabilities, maxBytes: 400 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
      expect(result.error.details).toMatchObject({ sizeBytes: 500, maxBytes: 400 });
    }
  });

  it("rejects duplicate names", () => {
    const result = checkBundle(
      [file("same", NEWICK, 10), file("same", CSV, 10)],
      { capabilities, maxBytes: 1024 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_INVALID");
  });

  it("enforces the protocol file count ceiling", () => {
    const files = Array.from({ length: 17 }, (_, index) => file(`f-${index}`, CSV, 1));
    const result = checkBundle(files, { capabilities, maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_COUNT_EXCEEDED");
  });
});
