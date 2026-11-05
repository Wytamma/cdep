import { fail, type Result } from "./errors.js";
import { schemaEquals } from "./negotiate.js";
import {
  MAX_BUNDLE_FILES,
  type FormatCapability,
  type SchemaRef,
} from "./types.js";

/**
 * Shared bundle policy used by the sender (matching against the receiver's
 * declared capabilities) and by the receiver (validating an offer or payload).
 *
 * Limits:
 * - `maxFileBytes` caps one file of that format;
 * - `maxFiles` caps how many files of that format appear;
 * - `maxBytes` caps the cumulative size of that format's files;
 * - the caller's `maxBytes` caps the whole bundle.
 */
export interface BundleFileInput {
  name: string;
  formatId: string;
  sizeBytes: number;
  schema?: SchemaRef;
}

export interface BundleLimits {
  capabilities: readonly FormatCapability[];
  /** Maximum total size of the bundle. */
  maxBytes: number;
  /** Maximum number of files in the bundle; defaults to the protocol cap. */
  maxFiles?: number;
}

export interface BundleStats {
  totalBytes: number;
  fileCount: number;
  /** Distinct format identifiers, in first-seen order. */
  formats: string[];
  bytesByFormat: Map<string, number>;
  countByFormat: Map<string, number>;
}

export function checkBundle(
  files: readonly BundleFileInput[],
  limits: BundleLimits,
): Result<BundleStats> {
  const maxFiles = Math.min(limits.maxFiles ?? MAX_BUNDLE_FILES, MAX_BUNDLE_FILES);
  if (files.length === 0 || files.length > maxFiles) {
    return fail("FILE_COUNT_EXCEEDED", "The bundle file count is outside the allowed range", {
      fileCount: files.length,
      maxFiles,
    });
  }

  const names = new Set<string>();
  const bytesByFormat = new Map<string, number>();
  const countByFormat = new Map<string, number>();
  const formats: string[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (names.has(file.name)) {
      return fail("PAYLOAD_INVALID", `Duplicate file name "${file.name}"`);
    }
    names.add(file.name);

    const capability = limits.capabilities.find((candidate) => candidate.id === file.formatId);
    if (!capability) {
      return fail("NO_COMMON_FORMAT", `The receiver cannot import ${file.formatId}`, {
        formatId: file.formatId,
        file: file.name,
      });
    }
    if (!schemaEquals(file.schema, capability.schema)) {
      return fail("SCHEMA_MISMATCH", `Schema mismatch for ${file.formatId}`, {
        formatId: file.formatId,
        file: file.name,
        offered: file.schema,
        accepted: capability.schema,
      });
    }

    const perFileLimit = Math.min(
      capability.maxFileBytes ?? Number.POSITIVE_INFINITY,
      capability.maxBytes ?? Number.POSITIVE_INFINITY,
      limits.maxBytes,
    );
    if (file.sizeBytes > perFileLimit) {
      return fail("SIZE_EXCEEDED", `File "${file.name}" exceeds the size limit`, {
        file: file.name,
        formatId: file.formatId,
        sizeBytes: file.sizeBytes,
        maxBytes: perFileLimit,
      });
    }

    if (!bytesByFormat.has(file.formatId)) formats.push(file.formatId);
    bytesByFormat.set(file.formatId, (bytesByFormat.get(file.formatId) ?? 0) + file.sizeBytes);
    countByFormat.set(file.formatId, (countByFormat.get(file.formatId) ?? 0) + 1);
    totalBytes += file.sizeBytes;
  }

  if (!Number.isSafeInteger(totalBytes)) {
    return fail("SIZE_EXCEEDED", "Bundle size is not a safe integer");
  }

  for (const formatId of formats) {
    const capability = limits.capabilities.find((candidate) => candidate.id === formatId);
    if (!capability) continue;

    const formatBytes = bytesByFormat.get(formatId) ?? 0;
    if (capability.maxBytes !== undefined && formatBytes > capability.maxBytes) {
      return fail("SIZE_EXCEEDED", `Files of ${formatId} exceed the per-format limit`, {
        formatId,
        sizeBytes: formatBytes,
        maxBytes: capability.maxBytes,
      });
    }

    const formatCount = countByFormat.get(formatId) ?? 0;
    const formatFileLimit = Math.min(
      capability.maxFiles ?? MAX_BUNDLE_FILES,
      MAX_BUNDLE_FILES,
    );
    if (formatCount > formatFileLimit) {
      return fail("FILE_COUNT_EXCEEDED", `Too many files of ${formatId}`, {
        formatId,
        fileCount: formatCount,
        maxFiles: formatFileLimit,
      });
    }
  }

  if (totalBytes > limits.maxBytes) {
    return fail("SIZE_EXCEEDED", "The bundle exceeds the total size limit", {
      sizeBytes: totalBytes,
      maxBytes: limits.maxBytes,
    });
  }

  return {
    ok: true,
    value: {
      totalBytes,
      fileCount: files.length,
      formats,
      bytesByFormat,
      countByFormat,
    },
  };
}
