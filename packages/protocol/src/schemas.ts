import { fail, type Result } from "./errors.js";
import type { AcceptRequest, CancelRequest, Offer, SchemaRef, TransferRequest } from "./types.js";
import {
  isArrayBuffer,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPlainObject,
  isPositiveSafeInteger,
} from "./validate.js";

export const MAX_DATASET_NAME = 200;
export const MAX_TRANSFER_ID = 128;
export const MAX_TRANSFER_MESSAGE = 500;
const MAX_OFFER_LIFETIME_MS = 60 * 60_000;

const TRANSFER_ID = /^[A-Za-z0-9._:-]+$/;
const FORMAT_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/** Local control characters make names unsafe to display and log. */
function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isTransferId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= MAX_TRANSFER_ID &&
    TRANSFER_ID.test(value)
  );
}

function isDatasetName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DATASET_NAME &&
    !hasControlChars(value)
  );
}

function isFormatId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && FORMAT_ID.test(value);
}

function isSchemaRef(value: unknown): value is SchemaRef {
  return isPlainObject(value) && isFormatId(value.id) && isPositiveSafeInteger(value.version);
}

function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Offer validation. The sender is untrusted: every field is checked before it
 * can reach a human or an import adapter.
 */
export function validateOffer(input: unknown): Result<Offer> {
  if (!isPlainObject(input)) return fail("OFFER_INVALID", "Offer must be an object");

  const dataset = input.dataset;
  if (!isPlainObject(dataset)) return fail("OFFER_INVALID", "dataset must be an object");

  const sender = input.sender;
  if (!isPlainObject(sender)) return fail("OFFER_INVALID", "sender must be an object");

  const offerId = input.offerId;
  if (!isTransferId(offerId)) {
    return fail("OFFER_INVALID", "offerId must be 8-128 identifier characters");
  }
  const transferId = input.transferId;
  if (!isTransferId(transferId)) {
    return fail("OFFER_INVALID", "transferId must be 8-128 identifier characters");
  }

  const name = dataset.name;
  if (!isDatasetName(name)) {
    return fail(
      "OFFER_INVALID",
      `dataset.name must be 1-${MAX_DATASET_NAME} characters without control characters`,
    );
  }
  const formatId = dataset.formatId;
  if (!isFormatId(formatId)) {
    return fail("OFFER_INVALID", "dataset.formatId must be a namespaced lowercase identifier");
  }
  const sizeBytes = dataset.sizeBytes;
  if (!isNonNegativeSafeInteger(sizeBytes)) {
    return fail("OFFER_INVALID", "dataset.sizeBytes must be a non-negative integer");
  }
  const mediaType = dataset.mediaType;
  if (mediaType !== undefined && !isNonEmptyString(mediaType, 200)) {
    return fail("OFFER_INVALID", "dataset.mediaType must be a short non-empty string");
  }

  let schema: SchemaRef | undefined;
  if (dataset.schema !== undefined) {
    if (!isSchemaRef(dataset.schema)) {
      return fail("OFFER_INVALID", "dataset.schema must be a valid schema reference");
    }
    schema = dataset.schema;
  }

  const senderOrigin = sender.origin;
  if (!isHttpOrigin(senderOrigin)) {
    return fail("OFFER_INVALID", "sender.origin must be an absolute http(s) origin");
  }
  const senderApplication = sender.application;
  if (!isNonEmptyString(senderApplication, 200)) {
    return fail("OFFER_INVALID", "sender.application must be a non-empty string");
  }

  const issuedAt = input.issuedAt;
  if (!isTimestamp(issuedAt)) return fail("OFFER_INVALID", "issuedAt must be a timestamp");
  const expiresAt = input.expiresAt;
  if (!isTimestamp(expiresAt)) return fail("OFFER_INVALID", "expiresAt must be a timestamp");
  if (expiresAt <= issuedAt) {
    return fail("OFFER_INVALID", "expiresAt must be after issuedAt");
  }
  if (expiresAt - issuedAt > MAX_OFFER_LIFETIME_MS) {
    return fail("OFFER_INVALID", "Offer lifetime may not exceed one hour");
  }

  return {
    ok: true,
    value: {
      offerId,
      transferId,
      dataset: {
        formatId,
        name,
        sizeBytes,
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(schema === undefined ? {} : { schema }),
      },
      sender: { origin: senderOrigin, application: senderApplication },
      issuedAt,
      expiresAt,
    },
  };
}

export function validateAcceptRequest(input: unknown): Result<AcceptRequest> {
  if (!isPlainObject(input)) return fail("OFFER_INVALID", "Accept request must be an object");
  const offerId = input.offerId;
  if (!isTransferId(offerId)) {
    return fail("OFFER_INVALID", "offerId must be 8-128 identifier characters");
  }
  const formatId = input.formatId;
  if (!isFormatId(formatId)) {
    return fail("OFFER_INVALID", "formatId must be a namespaced lowercase identifier");
  }
  return { ok: true, value: { offerId, formatId } };
}

export function validateTransferRequest(input: unknown): Result<TransferRequest> {
  if (!isPlainObject(input)) return fail("PAYLOAD_INVALID", "Transfer request must be an object");
  const transferId = input.transferId;
  if (!isTransferId(transferId)) {
    return fail("PAYLOAD_INVALID", "transferId must be 8-128 identifier characters");
  }
  const formatId = input.formatId;
  if (!isFormatId(formatId)) {
    return fail("PAYLOAD_INVALID", "formatId must be a namespaced lowercase identifier");
  }
  const sizeBytes = input.sizeBytes;
  if (!isNonNegativeSafeInteger(sizeBytes)) {
    return fail("PAYLOAD_INVALID", "sizeBytes must be a non-negative integer");
  }
  const data = input.data;
  if (typeof data !== "string" && !isArrayBuffer(data)) {
    return fail("PAYLOAD_INVALID", "data must be a string or an ArrayBuffer");
  }
  const mediaType = input.mediaType;
  if (mediaType !== undefined && !isNonEmptyString(mediaType, 200)) {
    return fail("PAYLOAD_INVALID", "mediaType must be a short non-empty string");
  }
  return {
    ok: true,
    value: {
      transferId,
      formatId,
      sizeBytes,
      ...(mediaType === undefined ? {} : { mediaType }),
      data,
    },
  };
}

export function validateCancelRequest(input: unknown): Result<CancelRequest> {
  if (!isPlainObject(input)) return fail("PAYLOAD_INVALID", "Cancel request must be an object");
  const transferId = input.transferId;
  if (!isTransferId(transferId)) {
    return fail("PAYLOAD_INVALID", "transferId must be 8-128 identifier characters");
  }
  const reason = input.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_TRANSFER_MESSAGE)) {
    return fail("PAYLOAD_INVALID", `reason must be up to ${MAX_TRANSFER_MESSAGE} characters`);
  }
  return {
    ok: true,
    value: { transferId, ...(reason === undefined ? {} : { reason }) },
  };
}
