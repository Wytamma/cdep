import { describe, expect, it } from "vitest";
import {
  MAX_DATASET_NAME,
  validateAcceptRequest,
  validateCancelRequest,
  validateOffer,
  validateTransferRequest,
  type Offer,
} from "../src/index.js";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);

const offer: Offer = {
  offerId: "offer-0001",
  transferId: "transfer-0001",
  dataset: {
    formatId: "cdep-test.format.tree",
    name: "demo tree",
    sizeBytes: 512,
  },
  sender: { origin: "https://sender.example", application: "Sequence App" },
  issuedAt: now,
  expiresAt: now + 60_000,
};

describe("validateOffer", () => {
  it("accepts a minimal offer", () => {
    const result = validateOffer(offer);
    expect(result.ok).toBe(true);
  });

  it("strips unknown fields from the dataset", () => {
    const result = validateOffer({
      ...offer,
      dataset: { ...offer.dataset, html: "<img onerror=alert(1)>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dataset).not.toHaveProperty("html");
  });

  it.each([
    ["dataset name with control characters", { dataset: { ...offer.dataset, name: "a\u0000b" } }],
    ["dataset name too long", { dataset: { ...offer.dataset, name: "x".repeat(MAX_DATASET_NAME + 1) } }],
    ["negative size", { dataset: { ...offer.dataset, sizeBytes: -1 } }],
    ["non-integer size", { dataset: { ...offer.dataset, sizeBytes: 1.5 } }],
    ["format id that is only an extension", { dataset: { ...offer.dataset, formatId: ".nwk" } }],
    ["origin with a path", { sender: { origin: "https://sender.example/app", application: "A" } }],
    ["origin with a trailing slash", { sender: { origin: "https://sender.example/", application: "A" } }],
    ["expiry before issue", { expiresAt: offer.issuedAt - 1 }],
    ["offer lifetime over an hour", { expiresAt: offer.issuedAt + 3_600_001 }],
    ["missing issuedAt", { issuedAt: undefined }],
    ["transfer id with spaces", { transferId: "transfer 0001" }],
    ["short transfer id", { transferId: "abc" }],
    ["schema with a non-integer version", { dataset: { ...offer.dataset, schema: { id: "cdep-test.schema.v1", version: 1.2 } } }],
  ])("rejects %s", (_name, patch) => {
    const result = validateOffer({ ...offer, ...patch });
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
  it("accepts offer and format identifiers", () => {
    expect(validateAcceptRequest({ offerId: "offer-0001", formatId: "org.cdep.format.newick.v1" }).ok).toBe(true);
  });

  it("rejects a mismatched casing", () => {
    expect(validateAcceptRequest({ offerId: "offer-0001", formatId: "org.cdep.format.newick.V1" }).ok).toBe(false);
  });
});

describe("validateTransferRequest", () => {
  it("accepts text payloads", () => {
    const result = validateTransferRequest({
      transferId: "transfer-0001",
      formatId: "org.cdep.format.newick.v1",
      sizeBytes: 5,
      data: "(A,B);",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts binary payloads", () => {
    const result = validateTransferRequest({
      transferId: "transfer-0001",
      formatId: "org.cdep.format.auspice.v2",
      sizeBytes: 4,
      data: new ArrayBuffer(4),
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a typed array instead of an ArrayBuffer", new Uint8Array(4)],
    ["an object", { data: "x" }],
    ["null", null],
  ])("rejects %s", (_name, data) => {
    const result = validateTransferRequest({
      transferId: "transfer-0001",
      formatId: "org.cdep.format.newick.v1",
      sizeBytes: 4,
      data,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYLOAD_INVALID");
  });

  it("rejects a negative declared size", () => {
    const result = validateTransferRequest({
      transferId: "transfer-0001",
      formatId: "org.cdep.format.newick.v1",
      sizeBytes: -1,
      data: "",
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateCancelRequest", () => {
  it("accepts an optional reason", () => {
    expect(validateCancelRequest({ transferId: "transfer-0001", reason: "user closed dialog" }).ok).toBe(true);
  });

  it("rejects an oversized reason", () => {
    expect(validateCancelRequest({ transferId: "transfer-0001", reason: "x".repeat(501) }).ok).toBe(false);
  });
});
