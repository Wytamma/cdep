import { describe, expect, it } from "vitest";
import type { Capabilities, Offer, TransferState } from "@cdep/protocol";
import { checkOffer, checkTransfer } from "../src/receiver-policy.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NEWICK = "org.cdep.format.newick.v1";
const FASTA = "org.cdep.format.fasta.v1";
const MAX = 1024;

const capabilities: Capabilities = {
  protocol: "cdep",
  version: 1,
  application: { name: "Tree Viewer" },
  imports: [{ id: NEWICK, label: "Newick", maxBytes: 512 }],
  exports: [],
};

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: "offer-0001",
    transferId: "transfer-0001",
    dataset: { formatId: NEWICK, name: "demo tree", sizeBytes: 10 },
    sender: { origin: "https://sender.example", application: "Sequence App" },
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function offerContext(extra: Partial<Parameters<typeof checkOffer>[1]> = {}) {
  return {
    capabilities,
    importIds: [NEWICK],
    verifiedOrigin: "https://sender.example",
    maxBytes: MAX,
    now: NOW,
    knownTransferIds: new Set<string>(),
    ...extra,
  };
}

describe("checkOffer", () => {
  it("accepts a well-formed offer", () => {
    const result = checkOffer(offer(), offerContext());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.limit).toBe(512);
  });

  it("rejects a claimed origin that differs from the verified one", () => {
    const result = checkOffer(
      offer({ sender: { origin: "https://evil.example", application: "Sequence App" } }),
      offerContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ORIGIN_MISMATCH");
      expect(result.error.details).toMatchObject({ verified: "https://sender.example" });
    }
  });

  it("rejects an expired offer", () => {
    const result = checkOffer(offer(), offerContext({ now: NOW + 60_001 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_EXPIRED");
  });

  it("rejects a replayed transfer id", () => {
    const result = checkOffer(offer(), offerContext({ knownTransferIds: new Set(["transfer-0001"]) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TRANSFER_STATE_INVALID");
  });

  it("rejects a format with no registered adapter", () => {
    const result = checkOffer(
      offer({ dataset: { formatId: FASTA, name: "seqs", sizeBytes: 10 } }),
      offerContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("rejects a format declared but not implemented", () => {
    const result = checkOffer(offer(), offerContext({ importIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_COMMON_FORMAT");
  });

  it("enforces the lower of capability and global ceilings", () => {
    const big = offer({ dataset: { formatId: NEWICK, name: "huge", sizeBytes: 900 } });
    const tooBigForCapability = checkOffer(big, offerContext());
    expect(tooBigForCapability.ok).toBe(false);
    if (!tooBigForCapability.ok) {
      expect(tooBigForCapability.error.code).toBe("SIZE_EXCEEDED");
      expect(tooBigForCapability.error.details).toMatchObject({ maxBytes: 512 });
    }

    const globalLimit = offer({ dataset: { formatId: NEWICK, name: "big", sizeBytes: 500 } });
    const result = checkOffer(globalLimit, offerContext({ maxBytes: 100 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toMatchObject({ maxBytes: 100 });
  });

  it("rejects a malformed offer before any policy check", () => {
    const result = checkOffer({ ...offer(), dataset: { ...offer().dataset, name: "" } }, offerContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OFFER_INVALID");
  });
});

function transferContext(
  state: TransferState = "ACCEPTED",
  extra: Partial<Parameters<typeof checkTransfer>[1]> = {},
) {
  return {
    record: { offer: offer(), state },
    capabilities,
    maxBytes: MAX,
    now: NOW,
    ...extra,
  };
}

const request = {
  transferId: "transfer-0001",
  formatId: NEWICK,
  sizeBytes: 10,
  data: "((A,B),C);",
};

describe("checkTransfer", () => {
  it("accepts a matching payload and measures it", () => {
    const result = checkTransfer(request, transferContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sizeBytes).toBe(10);
      expect(result.value.request.data).toBe("((A,B),C);");
    }
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

  it("rejects a format that does not match the accepted offer", () => {
    const result = checkTransfer({ ...request, formatId: FASTA }, transferContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCHEMA_MISMATCH");
  });

  it("rejects a declared size that differs from the bytes received", () => {
    const result = checkTransfer({ ...request, sizeBytes: 12 }, transferContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");
      expect(result.error.details).toMatchObject({ declared: 12, actual: 10, offered: 10 });
    }
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const accented = { ...request, sizeBytes: 1, data: "é" };
    const result = checkTransfer(accented, transferContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");

    const exact = { ...request, sizeBytes: 2, data: "é" };
    const accepted = checkTransfer(exact, transferContext("ACCEPTED", {
      record: { offer: offer({ dataset: { formatId: NEWICK, name: "e", sizeBytes: 2 } }), state: "ACCEPTED" },
    }));
    expect(accepted.ok).toBe(true);
  });

  it("rejects a payload above the local ceiling", () => {
    const result = checkTransfer(request, transferContext("ACCEPTED", { maxBytes: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SIZE_EXCEEDED");
  });

  it("rejects binary payloads with the wrong declared size", () => {
    const result = checkTransfer(
      { ...request, data: new ArrayBuffer(4), sizeBytes: 11 },
      transferContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_SIZE_MISMATCH");
  });
});
