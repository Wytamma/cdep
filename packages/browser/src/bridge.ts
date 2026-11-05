import {
  CdepException,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_OFFER_TTL_MS,
  assertLocalCapabilities,
  cdepError,
  isFormatId,
  isPlainObject,
  type Capabilities,
  type CdepError,
  type ExportValue,
  type FormatCapability,
  type Receipt,
  type SchemaRef,
} from "@cdep/protocol";
import type { ConsentOptions } from "./consent.js";
import { parseInvite } from "./handshake.js";
import {
  startReceiverSession,
  type ImportHandler,
  type ReceiverSession,
  type ReceiverSnapshot,
} from "./receiver.js";
import { sendDataset } from "./sender.js";

export interface ExportHandler {
  (): ExportValue | Promise<ExportValue>;
}

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
  /** Optional capability refinements (size ceilings, schemas) per format. */
  importCapabilities?: Record<string, Partial<FormatCapability>>;
  exportCapabilities?: Record<string, Partial<FormatCapability>>;
  /** Maps registry aliases (`newick`) to identifiers; defaults to identity. */
  normalizeFormatKey?: (key: string) => string;
  /** Absolute ceiling for payloads this application sends or accepts. */
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
  format?: string;
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

  const capabilities = assertLocalCapabilities({
    protocol: "cdep",
    version: 1,
    application: {
      name: options.application.name,
      ...(options.application.url === undefined ? {} : { url: options.application.url }),
    },
    imports: buildCapabilityList(
      importHandlers,
      options.importCapabilities ?? {},
      options.maxBytes,
    ),
    exports: buildCapabilityList(
      exportHandlers,
      options.exportCapabilities ?? {},
      options.maxBytes,
    ),
  });

  const applicationName = options.application.name;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const invite = readInvite();

  const receiver = invite
    ? startReceiverSession(invite, {
        capabilities,
        imports: importHandlers,
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
      const formatId =
        sendOptions.format === undefined ? undefined : normalizeKey(sendOptions.format);
      return sendDataset({
        targetUrl,
        ...(formatId === undefined ? {} : { formatId }),
        ...(sendOptions.signal === undefined ? {} : { signal: sendOptions.signal }),
        capabilities,
        applicationName,
        maxBytes,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        offerTtlMs: options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS,
        methodTimeoutMs: options.methodTimeoutMs ?? 60_000,
        exportFor: async (formatId) => {
          const handler = exportHandlers[formatId];
          if (!handler) {
            throw new CdepException(
              cdepError("NO_COMMON_FORMAT", `No export adapter is registered for ${formatId}`),
            );
          }
          return normalizeExport(await handler(), formatId, capabilities);
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

function normalizeExport(
  value: ExportValue,
  formatId: string,
  capabilities: Capabilities,
): ExportValue {
  if (typeof value !== "object" || value === null) {
    throw new CdepException(
      cdepError("INTERNAL", `The export adapter for ${formatId} must return an object`),
    );
  }

  const data: unknown = value.data;
  const isText = typeof data === "string";
  const isBinary =
    Object.prototype.toString.call(data) === "[object ArrayBuffer]" ||
    (typeof Uint8Array !== "undefined" && data instanceof Uint8Array);
  if (!isText && !isBinary) {
    throw new CdepException(
      cdepError(
        "INTERNAL",
        `The export adapter for ${formatId} returned neither text nor binary data`,
      ),
    );
  }

  const name = value.name;
  if (
    name !== undefined &&
    (typeof name !== "string" ||
      name.length === 0 ||
      name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(name))
  ) {
    throw new CdepException(
      cdepError("INTERNAL", `The export adapter for ${formatId} returned an invalid name`),
    );
  }

  let schema: SchemaRef | undefined;
  const schemaValue: unknown = value.schema;
  if (schemaValue !== undefined) {
    if (!isPlainObject(schemaValue)) {
      throw new CdepException(
        cdepError("INTERNAL", `The export adapter for ${formatId} returned an invalid schema`),
      );
    }
    const id = schemaValue.id;
    const version = schemaValue.version;
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
    schema = { id, version };
  }

  const capability = capabilities.exports.find((candidate) => candidate.id === formatId);
  const mediaType = value.mediaType ?? capability?.mediaTypes?.[0];
  return {
    data: value.data,
    ...(name === undefined ? {} : { name }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(schema === undefined ? {} : { schema }),
  };
}

function readInvite(): { sid: string } | undefined {
  const location = globalThis.location;
  return location ? parseInvite(location.hash) : undefined;
}
