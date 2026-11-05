/**
 * Dependency-free structural validation primitives.
 *
 * CDEP must validate everything arriving from the peer: a compromised or
 * hostile page can send any shape. These guards are the only thing standing
 * between the wire and the import adapters.
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

export class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get valid(): boolean {
    return this.issues.length === 0;
  }
}

const FORMAT_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const EXTENSION = /^\.[a-z0-9][a-z0-9.+_-]*$/i;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown, maxLength = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isFormatId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && FORMAT_ID.test(value);
}

export function isMediaType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && MEDIA_TYPE.test(value);
}

export function isExtension(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && EXTENSION.test(value);
}

export function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** An origin as produced by `URL#origin`: scheme + host + optional port, no path. */
export function isOriginString(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.origin !== "null";
  } catch {
    return false;
  }
}

export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

