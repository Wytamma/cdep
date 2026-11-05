import { describe, expect, it } from "vitest";
import {
  MAX_BUNDLE_FILES,
  MAX_DATASET_NAME,
  validateAcceptRequest,
  validateCancelRequest,
  validateOffer,
  validateTransferRequest,
  type Offer,
} from "../src/index.js";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const NEWICK = "org.cdep.format.newick.v1";
const CSV = "org.cdep.format.csv.v1";

const offer: Offer = {
  offerId: "offer-0001",
  transferId: "transfer-0001",
  dataset: {
    name: "tree + metadata",
    sizeBytes: 512,
    files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 512 }],
  },
  sender: { origin: "https://sender.example", application: "Sequence App" },
  issuedAt: now,
  expiresAt: now + 60_000,
};

const withDataset = (patch: Record<string, unknown>) => ({
  ...offer,
  dataset: { ...offer.dataset, ...patch },
});

describe("validateOffer", () => {
  it("accepts a minimal offer", () => {
    expect(validateOffer(offer).ok).toBe(true);
  });

  it("accepts mixed formats", () => {
    const result = validateOffer(
      withDataset({
        sizeBytes: 120,
        files: [
          { name: "tree.nwk", formatId: NEWICK, sizeBytes: 100 },
          { name: "metadata.csv", formatId: CSV, sizeBytes: 20 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataset.files.map((file) => file.formatId)).toEqual([NEWICK, CSV]);
    }
  });

  it("preserves per-file metadata", () => {
    const result = validateOffer(
      withDataset({
        sizeBytes: 10,
        files: [
          {
            name: "tree.nwk",
            formatId: NEWICK,
            sizeBytes: 10,
            metadata: { source: "sequence-app", tips: 4 },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataset.files[0]?.metadata).toEqual({
        source: "sequence-app",
        tips: 4,
      });
    }
  });

  it("strips unknown fields from the dataset and files", () => {
    const result = validateOffer({
      ...offer,
      dataset: {
        ...offer.dataset,
        html: "<img onerror=alert(1)>",
        files: [{ ...offer.dataset.files[0], html: "<script>" }],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataset).not.toHaveProperty("html");
      expect(result.value.dataset.files[0]).not.toHaveProperty("html");
    }
  });

  it.each([
    ["dataset name with control characters", withDataset({ name: "a\u0000b" })],
    ["dataset name too long", withDataset({ name: "x".repeat(MAX_DATASET_NAME + 1) })],
    ["negative total size", withDataset({ sizeBytes: -1 })],
    ["non-integer total size", withDataset({ sizeBytes: 1.5 })],
    ["origin with a path", { ...offer, sender: { origin: "https://sender.example/app", application: "A" } }],
    ["origin with a trailing slash", { ...offer, sender: { origin: "https://sender.example/", application: "A" } }],
    ["expiry before issue", { ...offer, expiresAt: offer.issuedAt - 1 }],
    ["offer lifetime over an hour", { ...offer, expiresAt: offer.issuedAt + 3_600_001 }],
    ["missing issuedAt", { ...offer, issuedAt: undefined }],
    ["transfer id with spaces", { ...offer, transferId: "transfer 0001" }],
    ["short transfer id", { ...offer, transferId: "abc" }],
    ["an empty file list", withDataset({ files: [], sizeBytes: 0 })],
    ["files that are not an array", withDataset({ files: "tree.nwk" })],
    [
      "a file without a format",
      withDataset({ files: [{ name: "tree.nwk", sizeBytes: 512 }] }),
    ],
    [
      "metadata that is not JSON",
      withDataset({
        files: [{ ...offer.dataset.files[0], metadata: { bad: () => 1 } }],
      }),
    ],
    [
      "a file with an extension as format",
      withDataset({ files: [{ name: "tree.nwk", formatId: ".nwk", sizeBytes: 512 }] }),
    ],
    [
      "a negative file size",
      withDataset({ files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: -1 }] }),
    ],
    [
      "a file name with control characters",
      withDataset({ files: [{ name: "tree\u0000.nwk", formatId: NEWICK, sizeBytes: 512 }] }),
    ],
    [
      "duplicate file names",
      withDataset({
        sizeBytes: 512,
        files: [
          { name: "tree.nwk", formatId: NEWICK, sizeBytes: 256 },
          { name: "tree.nwk", formatId: CSV, sizeBytes: 256 },
        ],
      }),
    ],
    [
      "a total that does not match the file sizes",
      withDataset({
        sizeBytes: 999,
        files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 512 }],
      }),
    ],
    [
      "more files than the protocol allows",
      withDataset({
        sizeBytes: 0,
        files: Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, index) => ({
          name: `tree-${index}.nwk`,
          formatId: NEWICK,
          sizeBytes: 0,
        })),
      }),
    ],
  ])("rejects %s", (_name, value) => {
    const result = validateOffer(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_INVALID");
  });

  it("rejects non-objects", () => {
    for (const value of [null, "offer", 42, []]) {
      expect(validateOffer(value).ok).toBe(false);
    }
  });
});

describe("validateAcceptRequest", () => {
  it("accepts an offer id", () => {
    expect(validateAcceptRequest({ offerId: "offer-0001" }).ok).toBe(true);
  });

  it("rejects a missing offer id", () => {
    expect(validateAcceptRequest({ formatId: NEWICK }).ok).toBe(false);
  });
});

const transfer = {
  transferId: "transfer-0001",
  sizeBytes: 6,
  files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 6, data: "(A,B);" }],
};

describe("validateTransferRequest", () => {
  it("accepts a single text file", () => {
    expect(validateTransferRequest(transfer).ok).toBe(true);
  });

  it("accepts mixed formats", () => {
    const result = validateTransferRequest({
      ...transfer,
      sizeBytes: 16,
      files: [
        { name: "a.nwk", formatId: NEWICK, sizeBytes: 6, data: "(A,B);" },
        { name: "b.csv", formatId: CSV, sizeBytes: 10, data: "name,length" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toHaveLength(2);
  });

  it("preserves per-file metadata", () => {
    const result = validateTransferRequest({
      ...transfer,
      files: [{ ...transfer.files[0], metadata: { checksum: "abc" } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files[0]?.metadata).toEqual({ checksum: "abc" });
  });

  it("accepts binary payloads", () => {
    const result = validateTransferRequest({
      ...transfer,
      sizeBytes: 4,
      files: [
        {
          name: "tree.json",
          formatId: "org.cdep.format.auspice.v2",
          sizeBytes: 4,
          data: new ArrayBuffer(4),
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a typed array instead of an ArrayBuffer", new Uint8Array(4)],
    ["an object", { data: "x" }],
    ["null", null],
  ])("rejects %s", (_name, data) => {
    const result = validateTransferRequest({
      ...transfer,
      files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 4, data }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_INVALID");
  });

  it.each([
    [
      "a file without a format",
      { ...transfer, files: [{ name: "tree.nwk", sizeBytes: 6, data: "(A,B);" }] },
    ],
    [
      "metadata numbers that are not finite",
      {
        ...transfer,
        files: [{ ...transfer.files[0], metadata: { n: Number.NaN } }],
      },
    ],
    [
      "a negative declared size",
      { ...transfer, files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: -1, data: "" }] },
    ],
    ["an empty file list", { ...transfer, sizeBytes: 0, files: [] }],
    [
      "duplicate file names",
      {
        ...transfer,
        sizeBytes: 12,
        files: [
          { name: "tree.nwk", formatId: NEWICK, sizeBytes: 6, data: "(A,B);" },
          { name: "tree.nwk", formatId: CSV, sizeBytes: 6, data: "(C,D);" },
        ],
      },
    ],
    [
      "a total that does not match the files",
      {
        ...transfer,
        sizeBytes: 99,
        files: [
          { name: "a.nwk", formatId: NEWICK, sizeBytes: 6, data: "(A,B);" },
          { name: "b.nwk", formatId: NEWICK, sizeBytes: 6, data: "(C,D);" },
        ],
      },
    ],
    [
      "more files than the protocol allows",
      {
        ...transfer,
        sizeBytes: 0,
        files: Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, index) => ({
          name: `f-${index}.nwk`,
          formatId: NEWICK,
          sizeBytes: 0,
          data: "",
        })),
      },
    ],
  ])("rejects %s", (_name, value) => {
    const result = validateTransferRequest(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_INVALID");
  });
});

describe("validateCancelRequest", () => {
  it("accepts an optional reason", () => {
    expect(
      validateCancelRequest({ transferId: "transfer-0001", reason: "user closed dialog" }).ok,
    ).toBe(true);
  });

  it("rejects an oversized reason", () => {
    expect(validateCancelRequest({ transferId: "transfer-0001", reason: "x".repeat(501) }).ok).toBe(
      false,
    );
  });
});
