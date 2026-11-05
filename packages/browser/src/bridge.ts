import {
  CdepException,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_OFFER_TTL_MS,
  MAX_BUNDLE_FILES,
  PROTOCOL,
  PROTOCOL_VERSION,
  assertLocalCapabilities,
  cdepError,
  isFormatId,
  isPlainObject,
  normalizeJson,
  type Capabilities,
  type CdepError,
  type ExportFile,
  type ExportValue,
  type FormatCapability,
  type JsonValue,
  type Receipt,
  type SchemaRef,
} from "@cdep/protocol";
import type { ConsentOptions } from "./consent.js";
import { parseInvite } from "./handshake.js";
import {
  startReceiverSession,
  type BundleImportHandler,
  type ImportHandler,
  type ReceiverSession,
  type ReceiverSnapshot,
} from "./receiver.js";
import { sendDataset, type SenderSelection } from "./sender.js";

export interface ExportHandler {
  (): ExportValue | Promise<ExportValue>;
}

/** A bundle export: every file must name its own format. */
export type BundleExportHandler = () => ExportValue | Promise<ExportValue>;

export interface BridgeOptions {
  application: {
    name: string;
    /** Canonical app URL; informational only, never used for origin checks. */
    url?: string;
  };
  /** Import adapters keyed by registry alias or full format identifier. */
  imports?: Record<string, ImportHandler>;
  /** Export adapters keyed by registry alias or full format identifier. */
  exports?: Record<string, ExportHandler>;
  /** Named mixed-format bundles the application can produce. */
  bundles?: Record<string, BundleExportHandler>;
  /** Handles bundles that mix formats; single-format bundles use `imports`. */
  importBundle?: BundleImportHandler;
  /** Optional capability refinements (size ceilings, schemas) per format. */
  importCapabilities?: Record<string, Partial<FormatCapability>>;
  exportCapabilities?: Record<string, Partial<FormatCapability>>;
  /** Maps registry aliases (`newick`) to identifiers; defaults to identity. */
  normalizeFormatKey?: (key: string) => string;
  /** Absolute ceiling for total payload size this application sends or accepts. */
  maxBytes?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  offerTtlMs?: number;
  methodTimeoutMs?: number;
  onTransferRequest?: ConsentOptions["onTransferRequest"];
  onState?: (snapshot: ReceiverSnapshot) => void;
  onError?: (error: CdepError) => void;
}

export interface SendOptions {
  /** Single-format send: the adapter must export that format. */
  format?: string;
  /** Named bundle send: files may mix formats. */
  bundle?: string;
  signal?: AbortSignal;
}

export interface Bridge {
  readonly capabilities: Capabilities;
  /** Present only when this page was opened as a CDEP receiver. */
  readonly receiver: ReceiverSession | undefined;
  sendTo(targetUrl: string, options?: SendOptions): Promise<Receipt>;
  destroy(): void;
}

export function createBridge(options: BridgeOptions): Bridge {
  const normalizeKey = options.normalizeFormatKey ?? ((key: string) => key);
  const importHandlers = normalizeHandlers(options.imports ?? {}, normalizeKey, "import");
  const exportHandlers = normalizeHandlers(options.exports ?? {}, normalizeKey, "export");
  const bundleHandlers = options.bundles ?? {};

  const capabilities = assertLocalCapabilities({
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    application: {
      name: options.application.name,
      ...(options.application.url === undefined ? {} : { url: options.application.url }),
    },
    imports: buildCapabilityList(importHandlers, options.importCapabilities ?? {}, options.maxBytes),
    exports: buildCapabilityList(exportHandlers, options.exportCapabilities ?? {}, options.maxBytes),
  });

  const applicationName = options.application.name;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const invite = readInvite();

  const receiver = invite
    ? startReceiverSession(invite, {
        capabilities,
        imports: importHandlers,
        ...(options.importBundle === undefined ? {} : { importBundle: options.importBundle }),
        maxBytes,
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        methodTimeoutMs: options.methodTimeoutMs ?? 60_000,
        consent: options.onTransferRequest
          ? { onTransferRequest: options.onTransferRequest }
          : {},
        ...(options.onState === undefined ? {} : { onState: options.onState }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      })
    : undefined;

  return {
    capabilities,
    receiver,
    async sendTo(targetUrl, sendOptions = {}) {
      if (sendOptions.format !== undefined && sendOptions.bundle !== undefined) {
        throw new CdepException(
          cdepError("INTERNAL", "sendTo accepts either format or bundle, not both"),
        );
      }

      const selection: SenderSelection =
        sendOptions.bundle !== undefined
          ? { bundle: sendOptions.bundle }
          : sendOptions.format === undefined
            ? {}
            : { format: normalizeKey(sendOptions.format) };

      if (selection.bundle !== undefined && bundleHandlers[selection.bundle] === undefined) {
        throw new CdepException(
          cdepError("INTERNAL", `Unknown bundle export "${selection.bundle}"`),
        );
      }

      return sendDataset({
        targetUrl,
        selection,
        ...(sendOptions.signal === undefined ? {} : { signal: sendOptions.signal }),
        capabilities,
        applicationName,
        maxBytes,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        offerTtlMs: options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS,
        methodTimeoutMs: options.methodTimeoutMs ?? 60_000,
        exportFor: async (resolved) => {
          if (resolved.bundle !== undefined) {
            const handler = bundleHandlers[resolved.bundle];
            if (!handler) {
              throw new CdepException(
                cdepError("INTERNAL", `Unknown bundle export "${resolved.bundle}"`),
              );
            }
            return normalizeExport(await handler(), { capabilities });
          }

          const formatId = resolved.format;
          if (formatId === undefined) {
            throw new CdepException(
              cdepError("INTERNAL", "A format selection is required for a single-format send"),
            );
          }
          const handler = exportHandlers[formatId];
          if (!handler) {
            throw new CdepException(
              cdepError("NO_COMMON_FORMAT", `No export adapter is registered for ${formatId}`),
            );
          }
          return normalizeExport(await handler(), { capabilities, formatId });
        },
      });
    },
    destroy() {
      receiver?.destroy();
    },
  };
}

function normalizeHandlers<T>(
  handlers: Record<string, T>,
  normalizeKey: (key: string) => string,
  direction: string,
): Record<string, T> {
  const normalized: Record<string, T> = {};
  for (const [key, handler] of Object.entries(handlers)) {
    const id = normalizeKey(key);
    if (normalized[id] !== undefined) {
      throw new CdepException(
        cdepError("CAPABILITIES_INVALID", `Two ${direction} adapters resolve to ${id}`),
      );
    }
    normalized[id] = handler;
  }
  return normalized;
}

function buildCapabilityList<T>(
  handlers: Record<string, T>,
  hints: Record<string, Partial<FormatCapability>>,
  maxBytes: number | undefined,
): FormatCapability[] {
  return Object.keys(handlers).map((id) => {
    const capability: FormatCapability = { ...hints[id], id };
    if (capability.maxBytes === undefined && maxBytes !== undefined) {
      capability.maxBytes = maxBytes;
    }
    return capability;
  });
}

function isSafeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isExportData(value: unknown): value is string | ArrayBuffer | Uint8Array {
  return (
    typeof value === "string" ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
    (typeof Uint8Array !== "undefined" && value instanceof Uint8Array)
  );
}

function readSchema(value: unknown, formatId: string): SchemaRef | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new CdepException(
      cdepError("INTERNAL", `The export adapter for ${formatId} returned an invalid schema`),
    );
  }
  const id = value.id;
  const version = value.version;
  if (
    !isFormatId(id) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    throw new CdepException(
      cdepError("INTERNAL", `The export adapter for ${formatId} returned an invalid schema`),
    );
  }
  return { id, version };
}

function normalizeExport(
  value: ExportValue,
  context: { capabilities: Capabilities; formatId?: string },
): ExportValue {
  if (typeof value !== "object" || value === null) {
    throw new CdepException(
      cdepError("INTERNAL", "The export adapter must return an object"),
    );
  }

  const fileValues: unknown = value.files;
  if (
    !Array.isArray(fileValues) ||
    fileValues.length === 0 ||
    fileValues.length > MAX_BUNDLE_FILES
  ) {
    throw new CdepException(
      cdepError(
        "INTERNAL",
        `Export adapters must return between 1 and ${MAX_BUNDLE_FILES} files`,
      ),
    );
  }

  const files: ExportFile[] = [];
  const names = new Set<string>();
  for (let index = 0; index < fileValues.length; index += 1) {
    const entry: unknown = fileValues[index];
    if (!isPlainObject(entry)) {
      throw new CdepException(cdepError("INTERNAL", "An export file must be an object"));
    }
    const name = entry.name;
    if (!isSafeName(name)) {
      throw new CdepException(cdepError("INTERNAL", "An export file has an invalid name"));
    }
    if (names.has(name)) {
      throw new CdepException(cdepError("INTERNAL", `Duplicate export file "${name}"`));
    }
    names.add(name);

    const formatId = entry.formatId ?? context.formatId;
    if (!isFormatId(formatId)) {
      throw new CdepException(
        cdepError(
          "INTERNAL",
          "Every export file in a bundle must declare a valid formatId",
        ),
      );
    }
    const capability = context.capabilities.exports.find(
      (candidate) => candidate.id === formatId,
    );
    if (!capability) {
      throw new CdepException(
        cdepError("INTERNAL", `The export adapter produced undeclared format ${formatId}`),
      );
    }

    const data = entry.data;
    if (!isExportData(data)) {
      throw new CdepException(
        cdepError("INTERNAL", `The export adapter for ${formatId} returned invalid data`),
      );
    }

    const mediaTypeValue = entry.mediaType;
    if (mediaTypeValue !== undefined && !isSafeName(mediaTypeValue)) {
      throw new CdepException(
        cdepError("INTERNAL", `The export adapter for ${formatId} returned an invalid media type`),
      );
    }
    const mediaType = mediaTypeValue ?? capability.mediaTypes?.[0];
    const schema = readSchema(entry.schema, formatId) ?? capability.schema;

    let metadata: JsonValue | undefined;
    if (entry.metadata !== undefined) {
      const normalized = normalizeJson(entry.metadata);
      if (!normalized.ok) {
        throw new CdepException(
          cdepError(
            "INTERNAL",
            `The export adapter for ${formatId} returned invalid metadata: ${normalized.reason}`,
          ),
        );
      }
      metadata = normalized.value;
    }

    files.push({
      name,
      formatId,
      data,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(schema === undefined ? {} : { schema }),
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  const name = value.name;
  if (name !== undefined && !isSafeName(name)) {
    throw new CdepException(
      cdepError("INTERNAL", "The export adapter returned an invalid bundle name"),
    );
  }

  const capability =
    context.formatId === undefined
      ? undefined
      : capabilitiesById(context.capabilities).get(context.formatId);
  const fallbackName =
    context.formatId === undefined
      ? "CDEP bundle"
      : `${capability?.label ?? context.formatId} bundle`;

  return { name: name ?? fallbackName, files };
}

function capabilitiesById(capabilities: Capabilities): Map<string, FormatCapability> {
  return new Map(capabilities.exports.map((capability) => [capability.id, capability]));
}

function readInvite(): { sid: string } | undefined {
  const location = globalThis.location;
  return location ? parseInvite(location.hash) : undefined;
}
