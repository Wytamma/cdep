import {
  checkBundle,
  fail,
  jsonEquals,
  payloadByteLength,
  validateOffer,
  validateTransferRequest,
  type BundleStats,
  type Capabilities,
  type Offer,
  type Result,
  type TransferRequest,
  type TransferState,
} from "@cdep/protocol";

/**
 * Pure receiver-side policy. Kept out of the DOM code so every rejection path
 * is unit-testable: these checks are the only thing between an untrusted
 * sender and an import adapter.
 */
export interface OfferContext {
  capabilities: Capabilities;
  /** Format identifiers that actually have a registered import adapter. */
  importIds: readonly string[];
  /** Whether a bundle-level import handler is registered (mixed formats). */
  bundleImport: boolean;
  /** Origin verified from the raw handshake, not the offer's claim. */
  verifiedOrigin: string;
  maxBytes: number;
  now: number;
  knownTransferIds: ReadonlySet<string>;
}

export interface OfferDecision {
  offer: Offer;
  stats: BundleStats;
}

export function checkOffer(input: unknown, context: OfferContext): Result<OfferDecision> {
  const parsed = validateOffer(input);
  if (!parsed.ok) return parsed;
  const offer = parsed.value;

  if (offer.sender.origin !== context.verifiedOrigin) {
    return fail(
      "ORIGIN_MISMATCH",
      "The offer's claimed origin does not match the verified peer origin",
      { claimed: offer.sender.origin, verified: context.verifiedOrigin },
    );
  }
  if (context.now > offer.expiresAt) {
    return fail("OFFER_EXPIRED", "The offer has already expired", { expiresAt: offer.expiresAt });
  }
  if (context.knownTransferIds.has(offer.transferId)) {
    return fail("TRANSFER_STATE_INVALID", "This transfer id is already in use");
  }

  const importCapabilities = context.capabilities.imports.filter((capability) =>
    context.importIds.includes(capability.id),
  );
  const checked = checkBundle(offer.dataset.files, {
    capabilities: importCapabilities,
    maxBytes: context.maxBytes,
  });
  if (!checked.ok) return checked;

  if (checked.value.formats.length > 1 && !context.bundleImport) {
    return fail(
      "NO_COMMON_FORMAT",
      "This application cannot import mixed-format bundles",
      { formats: checked.value.formats },
    );
  }

  return { ok: true, value: { offer, stats: checked.value } };
}

export interface TransferContext {
  record: { offer: Offer; state: TransferState } | undefined;
  capabilities: Capabilities;
  maxBytes: number;
  now: number;
}

export interface TransferDecision {
  request: TransferRequest;
  sizeBytes: number;
  formats: string[];
}

export function checkTransfer(input: unknown, context: TransferContext): Result<TransferDecision> {
  const parsed = validateTransferRequest(input);
  if (!parsed.ok) return parsed;
  const request = parsed.value;

  const record = context.record;
  if (!record) {
    return fail("OFFER_UNKNOWN", "Unknown transfer", { transferId: request.transferId });
  }
  if (record.state !== "ACCEPTED") {
    return fail("TRANSFER_STATE_INVALID", "The transfer was not accepted", {
      state: record.state,
    });
  }
  if (context.now > record.offer.expiresAt) {
    return fail("OFFER_EXPIRED", "The offer expired before the payload arrived");
  }

  const offered = record.offer.dataset.files;
  if (request.files.length !== offered.length) {
    return fail("PAYLOAD_INVALID", "File count does not match the offer", {
      received: request.files.length,
      offered: offered.length,
    });
  }

  const actual: Array<{
    name: string;
    formatId: string;
    sizeBytes: number;
    schema: (typeof offered)[number]["schema"];
  }> = [];
  let totalBytes = 0;

  for (const file of request.files) {
    const expected = offered.find((candidate) => candidate.name === file.name);
    if (!expected) {
      return fail("PAYLOAD_INVALID", `Unexpected file "${file.name}"`);
    }
    if (file.formatId !== expected.formatId) {
      return fail("PAYLOAD_INVALID", `File "${file.name}" changed format`, {
        file: file.name,
        offered: expected.formatId,
        received: file.formatId,
      });
    }
    if (!jsonEquals(file.metadata, expected.metadata)) {
      return fail("PAYLOAD_INVALID", `File "${file.name}" metadata differs from the offer`, {
        file: file.name,
      });
    }
    const size = payloadByteLength(file.data);
    if (size !== file.sizeBytes || size !== expected.sizeBytes) {
      return fail("PAYLOAD_SIZE_MISMATCH", `File "${file.name}" does not match the offered size`, {
        file: file.name,
        declared: file.sizeBytes,
        actual: size,
        offered: expected.sizeBytes,
      });
    }
    totalBytes += size;
    actual.push({
      name: file.name,
      formatId: file.formatId,
      sizeBytes: size,
      schema: expected.schema,
    });
  }

  if (totalBytes !== request.sizeBytes || totalBytes !== record.offer.dataset.sizeBytes) {
    return fail("PAYLOAD_SIZE_MISMATCH", "Bundle size does not match the offer", {
      declared: request.sizeBytes,
      actual: totalBytes,
      offered: record.offer.dataset.sizeBytes,
    });
  }

  const importCapabilities = context.capabilities.imports;
  const checked = checkBundle(actual, {
    capabilities: importCapabilities,
    maxBytes: context.maxBytes,
  });
  if (!checked.ok) return checked;

  return {
    ok: true,
    value: { request, sizeBytes: totalBytes, formats: checked.value.formats },
  };
}
