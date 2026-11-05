/**
 * CDEP error model.
 *
 * Errors cross a message boundary, so they are plain serializable objects,
 * not Error instances. `CdepException` is the local, throwable counterpart.
 */
export const CDEP_ERROR_CODES = [
  // Transport and session establishment.
  "TARGET_URL_INVALID",
  "HTTPS_REQUIRED",
  "POPUP_BLOCKED",
  "POPUP_CLOSED",
  "OPENER_UNAVAILABLE",
  "HANDSHAKE_FAILED",
  "HANDSHAKE_TIMEOUT",
  "ORIGIN_MISMATCH",
  "PROTOCOL_MISMATCH",
  "VERSION_UNSUPPORTED",
  // Discovery and negotiation.
  "CAPABILITIES_INVALID",
  "NO_COMMON_FORMAT",
  "AMBIGUOUS_FORMAT",
  "SCHEMA_MISMATCH",
  "SIZE_EXCEEDED",
  // Transfer lifecycle.
  "OFFER_INVALID",
  "OFFER_UNKNOWN",
  "OFFER_EXPIRED",
  "TRANSFER_STATE_INVALID",
  "PAYLOAD_INVALID",
  "PAYLOAD_SIZE_MISMATCH",
  "IMPORT_FAILED",
  "REJECTED",
  "CANCELLED",
  "TIMED_OUT",
  "INTERNAL",
] as const;

export type CdepErrorCode = (typeof CDEP_ERROR_CODES)[number];

export interface CdepError {
  code: CdepErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: CdepError };

export class CdepException extends Error {
  readonly code: CdepErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(error: CdepError) {
    super(error.message);
    this.name = "CdepException";
    this.code = error.code;
    this.details = error.details;
  }

  toJSON(): CdepError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function cdepError(
  code: CdepErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CdepError {
  return details ? { code, message, details } : { code, message };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(
  code: CdepErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Result<never> {
  return { ok: false, error: cdepError(code, message, details) };
}

/** Returns the value or throws `CdepException`. Use at SDK boundaries only. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new CdepException(result.error);
  return result.value;
}

export function isCdepError(value: unknown): value is CdepError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CdepError).code === "string" &&
    typeof (value as CdepError).message === "string" &&
    (CDEP_ERROR_CODES as readonly string[]).includes((value as CdepError).code)
  );
}

export function asCdepError(error: unknown, fallback: CdepErrorCode = "INTERNAL"): CdepError {
  if (isCdepError(error)) return error;
  if (error instanceof CdepException) return error.toJSON();
  if (error instanceof Error) {
    return cdepError(fallback, error.message || fallback);
  }
  return cdepError(fallback, typeof error === "string" ? error : fallback);
}

export function failedResult(error: unknown, fallback: CdepErrorCode = "INTERNAL"): Result<never> {
  return { ok: false, error: asCdepError(error, fallback) };
}
