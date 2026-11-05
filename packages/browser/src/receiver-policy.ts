import {
  fail,
  findImportCapability,
  payloadByteLength,
  validateOffer,
  validateTransferRequest,
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
  /** Origin verified from the raw handshake, not the offer's claim. */
  verifiedOrigin: string;
  maxBytes: number;
  now: number;
  knownTransferIds: ReadonlySet<string>;
}

export interface OfferDecision {
  offer: Offer;
  limit: number;
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
  if (!context.importIds.includes(offer.dataset.formatId)) {
    return fail("NO_COMMON_FORMAT", "The offered format is not importable here", {
      formatId: offer.dataset.formatId,
    });
  }

  const capability = findImportCapability(context.capabilities, offer.dataset.formatId);
  if (!capability) {
    return fail("NO_COMMON_FORMAT", "The offered format is not declared as importable", {
      formatId: offer.dataset.formatId,
    });
  }

  const limit = Math.min(capability.maxBytes ?? Number.POSITIVE_INFINITY, context.maxBytes);
  if (offer.dataset.sizeBytes > limit) {
    return fail("SIZE_EXCEEDED", "The offered dataset exceeds the local size limit", {
      sizeBytes: offer.dataset.sizeBytes,
      maxBytes: limit,
    });
  }

  return { ok: true, value: { offer, limit } };
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
  limit: number;
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
  if (request.formatId !== record.offer.dataset.formatId) {
    return fail("SCHEMA_MISMATCH", "Payload format does not match the accepted offer", {
      offered: record.offer.dataset.formatId,
      received: request.formatId,
    });
  }

  const actualSize = payloadByteLength(request.data);
  if (actualSize !== request.sizeBytes || actualSize !== record.offer.dataset.sizeBytes) {
    return fail("PAYLOAD_SIZE_MISMATCH", "Payload size does not match the offer", {
      declared: request.sizeBytes,
      actual: actualSize,
      offered: record.offer.dataset.sizeBytes,
    });
  }

  const capability = findImportCapability(context.capabilities, request.formatId);
  const limit = Math.min(capability?.maxBytes ?? Number.POSITIVE_INFINITY, context.maxBytes);
  if (actualSize > limit) {
    return fail("SIZE_EXCEEDED", "Payload exceeds the local size limit", {
      sizeBytes: actualSize,
      maxBytes: limit,
    });
  }

  return { ok: true, value: { request, sizeBytes: actualSize, limit } };
}

