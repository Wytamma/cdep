import { fail, ok, type Result } from "./errors.js";
import type { FormatCapability, SchemaRef } from "./types.js";

export interface NegotiationOptions {
  /** Restricts negotiation to one format identifier. */
  requestedFormat?: string;
  /** Payload size known before the offer; enforces both declared limits. */
  sizeBytes?: number;
}

export interface FormatMatch {
  formatId: string;
  exportCapability: FormatCapability;
  importCapability: FormatCapability;
  /** Minimum of both declared ceilings; undefined when neither declares one. */
  maxBytes?: number;
}

export function schemaEquals(a: SchemaRef | undefined, b: SchemaRef | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.version === b.version;
}

function limitOf(exportCapability: FormatCapability, importCapability: FormatCapability): number | undefined {
  const limits = [exportCapability.maxBytes, importCapability.maxBytes].filter(
    (value): value is number => typeof value === "number",
  );
  return limits.length === 0 ? undefined : Math.min(...limits);
}

/**
 * Exact-identifier matching only. No aliases, no extension guessing, no
 * conversion: a wrong guess imports garbage into a scientific application.
 *
 * A capability pair matches when:
 * 1. identifiers are byte-identical;
 * 2. both declare the same schema (or neither does);
 * 3. the payload fits the lower of the declared ceilings.
 */
export function negotiate(
  exports: readonly FormatCapability[],
  imports: readonly FormatCapability[],
  options: NegotiationOptions = {},
): Result<FormatMatch[]> {
  const importById = new Map(imports.map((capability) => [capability.id, capability]));

  const candidates: FormatMatch[] = [];
  for (const exportCapability of exports) {
    const importCapability = importById.get(exportCapability.id);
    if (!importCapability) continue;
    if (!schemaEquals(exportCapability.schema, importCapability.schema)) continue;
    const maxBytes = limitOf(exportCapability, importCapability);
    candidates.push({
      formatId: exportCapability.id,
      exportCapability,
      importCapability,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
  }

  candidates.sort((a, b) => a.formatId.localeCompare(b.formatId));

  if (options.requestedFormat !== undefined) {
    const requested = candidates.filter((match) => match.formatId === options.requestedFormat);
    if (requested.length === 0) {
      return fail("NO_COMMON_FORMAT", `The receiver does not accept ${options.requestedFormat}`, {
        requested: options.requestedFormat,
        senderFormats: exports.map((capability) => capability.id),
        receiverFormats: imports.map((capability) => capability.id),
      });
    }
    const [match] = requested;
    if (options.sizeBytes !== undefined && match?.maxBytes !== undefined && options.sizeBytes > match.maxBytes) {
      return fail("SIZE_EXCEEDED", "Dataset exceeds the declared size limit", {
        formatId: match.formatId,
        sizeBytes: options.sizeBytes,
        maxBytes: match.maxBytes,
      });
    }
    return ok(requested);
  }

  if (candidates.length === 0 || options.sizeBytes === undefined) return ok(candidates);

  const sizeBytes = options.sizeBytes;
  const viable = candidates.filter(
    (candidate) => candidate.maxBytes === undefined || sizeBytes <= candidate.maxBytes,
  );
  if (viable.length > 0) return ok(viable);

  const [first] = candidates;
  return fail("SIZE_EXCEEDED", "Dataset exceeds every negotiated size limit", {
    formatId: first?.formatId,
    sizeBytes,
    maxBytes: first?.maxBytes,
  });
}

/** Narrows a candidate list to exactly one usable format. */
export function selectMatch(matches: readonly FormatMatch[]): Result<FormatMatch> {
  const [match] = matches;
  if (!match) {
    return fail("NO_COMMON_FORMAT", "No compatible format was found", { candidates: [] });
  }
  if (matches.length > 1) {
    return fail("AMBIGUOUS_FORMAT", "More than one compatible format exists; choose one explicitly", {
      candidates: matches.map((candidate) => candidate.formatId),
    });
  }
  return ok(match);
}
