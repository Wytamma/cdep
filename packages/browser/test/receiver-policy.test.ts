import { describe, expect, it } from "vitest";
import type {
  Capabilities,
  DatasetFileDescriptor,
  Offer,
  TransferState,
} from "@cdep/protocol";
import { checkOffer, checkTransfer } from "../src/receiver-policy.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NEWICK = "org.cdep.format.newick.v1";
const CSV = "org.cdep.format.csv.v1";
const MAX = 2048;
const TEXT = "((A,B),C);";
const CSV_TEXT = "name,length";

const capabilities: Capabilities = {
  protocol: "cdep",
  version: 3,
  application: { name: "Tree Viewer" },
  imports: [
    { id: NEWICK, label: "Newick", maxBytes: 512, maxFiles: 2, maxFileBytes: 300 },
    { id: CSV, label: "CSV", maxBytes: 1024, maxFiles: 4, maxFileBytes: 500 },
  ],
  exports: [],
};

function file(name: string, formatId: string, sizeBytes: number): DatasetFileDescriptor {
  return { name, formatId, sizeBytes };
}

function offerWith(
  descriptors: DatasetFileDescriptor[] = [file("tree.nwk", NEWICK, 10)],
): Offer {
  return {
    offerId: "offer-0001",
    transferId: "transfer-0001",
    dataset: {
      name: "tree + metadata",
      sizeBytes: descriptors.reduce((sum, file) => sum + file.sizeBytes, 0),
      files: descriptors,
    },
    sender: { origin: "https://sender.example", application: "Sequence App" },
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
  };
}

function offerContext(extra: Partial<Parameters<typeof checkOffer>[1]> = {}) {
  return {
    capabilities,
    importIds: [NEWICK, CSV],
    bundleImport: true,
    verifiedOrigin: "https://sender.example",
    maxBytes: MAX,
    now: NOW,
    knownTransferIds: new Set<string>(),
    ...extra,
  };
}

describe("checkOffer", () => {
  it("accepts a well-formed offer", () => {
    const result = checkOffer(offerWith(), offerContext());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stats.formats).toEqual([NEWICK]);
  });

  it("accepts a multi-file same-format bundle", () => {
    const result = checkOffer(
      {
        ...offerWith([
          { name: "a.nwk", formatId: NEWICK, sizeBytes: 10 },
          { name: "b.nwk", formatId: NEWICK, sizeBytes: 20 },
        ]),
      },
      offerContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a mixed-format bundle when a bundle importer exists", () => {
    const result = checkOffer(
      withFiles([["tree.nwk", NEWICK, 100], ["metadata.csv", CSV, 20]]),
      offerContext(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stats.formats).toEqual([NEWICK, CSV]);
  });

  it("rejects a mixed bundle without a bundle import handler", () => {
    const result = checkOffer(
      withDatasetFiles([
        ["tree.nwk", NEWICK, 100],
        ["metadata.csv", CSV, 20],
      ]),
      offerContext({ bundleImport: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_COMMON_FORMAT");
      expect(result.error.details).toMatchObject({ formats: [NEWICK, CSV] });
    }
  });

  it("rejects a claimed origin that differs from the verified one", () => {
    const offer = offerWith();
    offer.sender.origin = "https://evil.example";
    const result = checkOffer(offer, offerContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ORIGIN_MISMATCH");
      expect(result.error.details).toMatchObject({ verified: "https://sender.example" });
    }
  });

  it("rejects an expired offer", () => {
    const result = checkOffer(offerWith(), offerContext({ now: NOW + 60_001 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_EXPIRED");
  });

  it("rejects a replayed transfer id", () => {
    const result = checkOffer(
      offerWith(),
      offerContext({ knownTransferIds: new Set(["transfer-0001"]) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TRANSFER_STATE_INVALID");
  });

  it("rejects a format with no registered adapter", () => {
    const result = checkOffer(offerWith([file("data.bin", "org.cdep.format.bin.v1", 10)]), offerContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("rejects a format declared but not implemented", () => {
    const result = checkOffer(offerWith(), offerContext({ importIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("enforces per-file and total ceilings", () => {
    const perFile = checkOffer(offerWith([file("big.nwk", NEWICK, 301)]), offerContext());
    expect(perFile.ok).toBe(false);
    if (!perFile.ok) {
      expect(perFile.error.code).toBe("SIZE_EXCEEDED");
      expect(perFile.error.details).toMatchObject({ file: "big.nwk", maxBytes: 300 });
    }

    const total = checkOffer(offerWith([file("big.nwk", NEWICK, 100)]), offerContext({ maxBytes: 50 }));
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.error.details).toMatchObject({ maxBytes: 50 });
  });

  it("enforces the per-format cumulative ceiling", () => {
    const result = checkOffer(
      offerWith([file("a.nwk", NEWICK, 300), file("b.nwk", NEWICK, 300)]),
      offerContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SIZE_EXCEEDED");
  });

  it("enforces per-format file counts", () => {
    const result = checkOffer(
      offerWith([
        file("a.nwk", NEWICK, 10),
        file("b.nwk", NEWICK, 10),
        file("c.nwk", NEWICK, 10),
      ]),
      offerContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FILE_COUNT_EXCEEDED");
  });

  it("rejects a malformed offer before any policy check", () => {
    const broken = offerWith();
    broken.dataset.name = "";
    const result = checkOffer(broken, offerContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_INVALID");
  });
});

function withFiles(specs: Array<[string, string, number]>) {
  return offerWith(specs.map(([name, formatId, sizeBytes]) => ({ name, formatId, sizeBytes })));
}

function withDatasetFiles(specs: Array<[string, string, number]>) {
  return withFiles(specs);
}

function transferContext(
  state: TransferState = "ACCEPTED",
  extra: Partial<Parameters<typeof checkTransfer>[1]> = {},
) {
  return {
    record: { offer: offerWith(), state },
    capabilities,
    maxBytes: MAX,
    now: NOW,
    ...extra,
  };
}

const request = {
  transferId: "transfer-0001",
  sizeBytes: TEXT.length,
  files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: TEXT.length, data: TEXT }],
};

describe("checkTransfer", () => {
  it("accepts a matching payload and measures it", () => {
    const result = checkTransfer(request, transferContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBe(TEXT.length);
      expect(result.value.formats).toEqual([NEWICK]);
    }
  });

  it("requires transfer metadata to match the offer", () => {
    const offer = offerWith();
    const descriptor = offer.dataset.files[0];
    if (!descriptor) throw new Error("fixture is missing a file");
    descriptor.metadata = { source: "sequence-app", tips: 4 };
    const context = transferContext("ACCEPTED", {
      record: { offer, state: "ACCEPTED" },
    });

    const matching = checkTransfer(
      {
        ...request,
        files: [
          { ...request.files[0], metadata: { tips: 4, source: "sequence-app" } },
        ],
      },
      context,
    );
    expect(matching.ok).toBe(true);

    const differing = checkTransfer(
      { ...request, files: [{ ...request.files[0], metadata: { tips: 5 } }] },
      context,
    );
    expect(differing.ok).toBe(false);
    if (!differing.ok) expect(differing.error.code).toBe("PAYLOAD_INVALID");
  });

  it("accepts a matching mixed-format payload", () => {
    const result = checkTransfer(
      {
        ...request,
        sizeBytes: TEXT.length + CSV_TEXT.length,
        files: [
          { name: "tree.nwk", formatId: NEWICK, sizeBytes: TEXT.length, data: TEXT },
          { name: "metadata.csv", formatId: CSV, sizeBytes: CSV_TEXT.length, data: CSV_TEXT },
        ],
      },
      transferContext("ACCEPTED", {
        record: {
          offer: offerWith([
            file("tree.nwk", NEWICK, TEXT.length),
            file("metadata.csv", CSV, CSV_TEXT.length),
          ]),
          state: "ACCEPTED",
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.formats).toEqual([NEWICK, CSV]);
  });

  it("rejects an unknown transfer", () => {
    const result = checkTransfer(request, transferContext("ACCEPTED", { record: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_UNKNOWN");
  });

  it.each(["OFFERED", "TRANSFERRING", "IMPORTED", "FAILED"] as const)(
    "rejects a payload in state %s",
    (state) => {
      const result = checkTransfer(request, transferContext(state));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TRANSFER_STATE_INVALID");
    },
  );

  it("rejects a payload after the offer expired", () => {
    const result = checkTransfer(request, transferContext("ACCEPTED", { now: NOW + 60_001 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_EXPIRED");
  });

  it("rejects a file set that does not match the offer", () => {
    const count = checkTransfer(
      {
        ...request,
        sizeBytes: 20,
        files: [
          { name: "tree.nwk", formatId: NEWICK, sizeBytes: 10, data: TEXT },
          { name: "extra.nwk", formatId: NEWICK, sizeBytes: 10, data: TEXT },
        ],
      },
      transferContext(),
    );
    expect(count.ok).toBe(false);
    if (!count.ok) expect(count.error.code).toBe("PAYLOAD_INVALID");

    const renamed = checkTransfer(
      { ...request, files: [{ ...request.files[0], name: "other.nwk" }] },
      transferContext(),
    );
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error.code).toBe("PAYLOAD_INVALID");

    const reformatted = checkTransfer(
      { ...request, files: [{ ...request.files[0], formatId: CSV }] },
      transferContext(),
    );
    expect(reformatted.ok).toBe(false);
    if (!reformatted.ok) expect(reformatted.error.code).toBe("PAYLOAD_INVALID");
  });

  it("rejects a declared size that differs from the bytes received", () => {
    const result = checkTransfer(
      { ...request, sizeBytes: 12, files: [{ ...request.files[0], sizeBytes: 12 }] },
      transferContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");
      expect(result.error.details).toMatchObject({ declared: 12, actual: 10, offered: 10 });
    }
  });

  it("rejects a total that differs from the file sizes", () => {
    const result = checkTransfer({ ...request, sizeBytes: 11 }, transferContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_INVALID");
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const accented = {
      ...request,
      sizeBytes: 1,
      files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 1, data: "é" }],
    };
    const result = checkTransfer(accented, transferContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");

    const exact = {
      ...request,
      sizeBytes: 2,
      files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 2, data: "é" }],
    };
    const accepted = checkTransfer(
      exact,
      transferContext("ACCEPTED", {
        record: { offer: offerWith([file("tree.nwk", NEWICK, 2)]), state: "ACCEPTED" },
      }),
    );
    expect(accepted.ok).toBe(true);
  });

  it("rejects a payload above the local ceiling", () => {
    const result = checkTransfer(request, transferContext("ACCEPTED", { maxBytes: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SIZE_EXCEEDED");
  });

  it("rejects a file above the per-file ceiling", () => {
    const result = checkTransfer(
      {
        ...request,
        sizeBytes: 301,
        files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 301, data: "x".repeat(301) }],
      },
      transferContext("ACCEPTED", {
        record: { offer: offerWith([file("tree.nwk", NEWICK, 301)]), state: "ACCEPTED" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
      expect(result.error.details).toMatchObject({ file: "tree.nwk", maxBytes: 300 });
    }
  });

  it("rejects binary payloads with the wrong declared size", () => {
    const result = checkTransfer(
      {
        ...request,
        sizeBytes: 10,
        files: [{ name: "tree.nwk", formatId: NEWICK, sizeBytes: 10, data: new ArrayBuffer(4) }],
      },
      transferContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");
  });
});
