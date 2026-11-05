import { CallOptions } from "penpal";
import {
  CdepException,
  asCdepError,
  cdepError,
  fail,
  findImportCapability,
  isPlainObject,
  isTerminalState,
  ok,
  transition,
  validateCancelRequest,
  type AcceptAck,
  type CancelAck,
  type Capabilities,
  type CdepError,
  type ImportContext,
  type ImportedDataset,
  type Offer,
  type OfferAck,
  type Receipt,
  type Result,
  type TransferState,
  type TransferStatus,
} from "@cdep/protocol";
import { requestConsent, type ConsentOptions, type ConsentRequest } from "./consent.js";
import { stripInvite, waitForHello } from "./handshake.js";
import { checkOffer, checkTransfer } from "./receiver-policy.js";
import { readRemoteResult, toTransportError } from "./result.js";
import { openTransport, type Transport } from "./transport.js";
import type { ReceiverWire, SenderWire } from "./wire.js";

export type ImportHandler = (
  dataset: ImportedDataset,
  context: ImportContext,
) => void | Promise<void>;

export interface ReceiverSnapshot {
  transferId: string;
  state: TransferState;
  datasetName: string;
  formatId: string;
  error?: CdepError;
}

export interface ReceiverOptions {
  capabilities: Capabilities;
  imports: Record<string, ImportHandler>;
  maxBytes: number;
  handshakeTimeoutMs: number;
  connectTimeoutMs: number;
  methodTimeoutMs: number;
  consent: ConsentOptions;
  onState?: (snapshot: ReceiverSnapshot) => void;
  onError?: (error: CdepError) => void;
}

export interface ReceiverSession {
  /** Resolves when the session ends; failures are reported through `onError`. */
  started: Promise<void>;
  destroy(): void;
}

interface TransferRecord {
  offer: Offer;
  state: TransferState;
  updatedAt: number;
  error?: CdepError;
  receipt?: Receipt;
}

const MAX_REMEMBERED_TRANSFERS = 16;

/**
 * Receiving side of one invited session. The application page is the receiver:
 * there is no separate `receiver.html` entry, so import adapters run in the
 * real application with its real state.
 */
export function startReceiverSession(
  invite: { sid: string },
  options: ReceiverOptions,
): ReceiverSession {
  const records = new Map<string, TransferRecord>();
  const importIds = Object.keys(options.imports);
  let transport: Transport<SenderWire> | undefined;
  let verifiedOrigin = "";
  let destroyed = false;

  const notify = (record: TransferRecord): void => {
    options.onState?.({
      transferId: record.offer.transferId,
      state: record.state,
      datasetName: record.offer.dataset.name,
      formatId: record.offer.dataset.formatId,
      ...(record.error === undefined ? {} : { error: record.error }),
    });
  };

  const remember = (record: TransferRecord): void => {
    if (records.size >= MAX_REMEMBERED_TRANSFERS) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    records.set(record.offer.transferId, record);
  };

  const handleOffer = async (input: unknown): Promise<Result<OfferAck>> => {
    const decision = checkOffer(input, {
      capabilities: options.capabilities,
      importIds,
      verifiedOrigin,
      maxBytes: options.maxBytes,
      now: Date.now(),
      knownTransferIds: new Set(records.keys()),
    });
    if (!decision.ok) return decision;
    const offer = decision.value.offer;

    const capability = findImportCapability(options.capabilities, offer.dataset.formatId);
    if (!capability) {
      return fail("NO_COMMON_FORMAT", "The offered format is not declared as importable");
    }

    const record: TransferRecord = { offer, state: "OFFERED", updatedAt: Date.now() };
    remember(record);
    notify(record);

    const consentRequest: ConsentRequest = {
      receiverApplication: options.capabilities.application.name,
      senderApplication: offer.sender.application,
      senderOrigin: verifiedOrigin,
      datasetName: offer.dataset.name,
      formatLabel: capability.label ?? offer.dataset.formatId,
      formatId: offer.dataset.formatId,
      sizeBytes: offer.dataset.sizeBytes,
    };
    const approved = await requestConsent(consentRequest, {
      ...options.consent,
      timeoutMs:
        options.consent.timeoutMs ?? Math.max(1_000, offer.expiresAt - Date.now()),
    });

    if (!approved) {
      record.state = "REJECTED";
      record.updatedAt = Date.now();
      notify(record);
      return fail("REJECTED", "The receiving application declined the transfer", {
        transferId: offer.transferId,
        datasetName: offer.dataset.name,
      });
    }

    record.state = "ACCEPTED";
    record.updatedAt = Date.now();
    notify(record);

    const remote = transport?.remote;
    if (!remote) {
      return fail("HANDSHAKE_FAILED", "The sender channel is no longer available");
    }

    try {
      const ack = readRemoteResult(
        await remote.accept(
          { offerId: offer.offerId, formatId: offer.dataset.formatId },
          new CallOptions({ timeout: options.methodTimeoutMs }),
        ),
        validateAcceptAck,
        "accept",
      );
      if (!ack.ok) {
        record.state = "FAILED";
        record.error = ack.error;
        record.updatedAt = Date.now();
        notify(record);
        return ack;
      }
      if (ack.value.transferId !== offer.transferId) {
        record.state = "FAILED";
        record.error = cdepError("INTERNAL", "accept: transferId mismatch");
        record.updatedAt = Date.now();
        notify(record);
        return { ok: false, error: record.error };
      }
    } catch (cause) {
      record.state = "FAILED";
      record.error = toTransportError(cause, "accept");
      record.updatedAt = Date.now();
      notify(record);
      return { ok: false, error: record.error };
    }

    return ok({
      offerId: offer.offerId,
      transferId: offer.transferId,
      state: "OFFERED",
      expiresAt: offer.expiresAt,
    });
  };

  const handleTransfer = async (input: unknown): Promise<Result<Receipt>> => {
    const record = isPlainObject(input) ? records.get(String(input.transferId)) : undefined;
    const decision = checkTransfer(input, {
      record: record ? { offer: record.offer, state: record.state } : undefined,
      capabilities: options.capabilities,
      maxBytes: options.maxBytes,
      now: Date.now(),
    });
    if (!decision.ok) {
      const fatal =
        decision.error.code === "PAYLOAD_SIZE_MISMATCH" ||
        decision.error.code === "SIZE_EXCEEDED" ||
        decision.error.code === "SCHEMA_MISMATCH";
      const expired = decision.error.code === "OFFER_EXPIRED";
      if (record && (fatal || expired)) {
        record.state = expired ? "TIMED_OUT" : "FAILED";
        record.error = decision.error;
        record.updatedAt = Date.now();
        notify(record);
      }
      return decision;
    }

    const { request, sizeBytes } = decision.value;
    if (!record) return fail("OFFER_UNKNOWN", "Unknown transfer");

    const started = transition(record.state, "TRANSFER_START");
    if (!started.ok) return started;
    record.state = started.value;
    record.updatedAt = Date.now();
    notify(record);

    const dataset: ImportedDataset = {
      formatId: request.formatId,
      name: record.offer.dataset.name,
      sizeBytes,
      ...(record.offer.dataset.mediaType === undefined
        ? {}
        : { mediaType: record.offer.dataset.mediaType }),
      data: request.data,
    };

    const handler = options.imports[request.formatId];
    if (!handler) {
      return fail("NO_COMMON_FORMAT", "The format is no longer importable", {
        formatId: request.formatId,
      });
    }

    try {
      await handler(dataset, {
        transferId: request.transferId,
        senderOrigin: verifiedOrigin,
        senderApplication: record.offer.sender.application,
      });
    } catch (cause) {
      record.state = "FAILED";
      record.error = asCdepError(cause, "IMPORT_FAILED");
      record.updatedAt = Date.now();
      notify(record);
      return { ok: false, error: record.error };
    }

    const receipt: Receipt = {
      transferId: request.transferId,
      formatId: request.formatId,
      state: "IMPORTED",
      importedAt: Date.now(),
      sizeBytes,
    };
    record.receipt = receipt;
    record.state = "IMPORTED";
    record.updatedAt = Date.now();
    notify(record);
    return ok(receipt);
  };

  const handleStatus = async (input: unknown): Promise<Result<TransferStatus>> => {
    if (!isPlainObject(input) || typeof input.transferId !== "string") {
      return fail("PAYLOAD_INVALID", "getStatus: invalid request");
    }
    const record = records.get(input.transferId);
    if (!record) {
      return fail("OFFER_UNKNOWN", "Unknown transfer", { transferId: input.transferId });
    }
    return ok({
      transferId: record.offer.transferId,
      state: record.state,
      updatedAt: record.updatedAt,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
    });
  };

  const handleCancel = async (input: unknown): Promise<Result<CancelAck>> => {
    const parsed = validateCancelRequest(input);
    if (!parsed.ok) return parsed;
    const record = records.get(parsed.value.transferId);
    if (!record || isTerminalState(record.state)) {
      return ok({ transferId: parsed.value.transferId, cancelled: false });
    }
    const cancelled = transition(record.state, "CANCEL");
    if (cancelled.ok) {
      record.state = cancelled.value;
      record.updatedAt = Date.now();
      notify(record);
    }
    return ok({ transferId: parsed.value.transferId, cancelled: cancelled.ok });
  };

  const methods: ReceiverWire = {
    async getCapabilities() {
      return ok(options.capabilities);
    },
    offer: (input) => guard("offer", () => handleOffer(input)),
    transfer: (input) => guard("transfer", () => handleTransfer(input)),
    getStatus: (input) => guard("getStatus", () => handleStatus(input)),
    cancel: (input) => guard("cancel", () => handleCancel(input)),
  };

  async function run(): Promise<void> {
    const receiverWindow = globalThis.window;
    if (!receiverWindow) {
      throw new CdepException(cdepError("INTERNAL", "CDEP receiving requires a browser window"));
    }
    if (destroyed) return;

    const hello = await waitForHello({
      sid: invite.sid,
      timeoutMs: options.handshakeTimeoutMs,
      window: receiverWindow,
    });
    verifiedOrigin = hello.origin;
    stripInviteFromLocation(receiverWindow);

    transport = await openTransport<SenderWire>({
      remoteWindow: receiverWindow.opener,
      allowedOrigin: verifiedOrigin,
      channel: invite.sid,
      timeoutMs: options.connectTimeoutMs,
      methods,
    });
  }

  const started = run().catch((cause: unknown) => {
    options.onError?.(
      cause instanceof CdepException
        ? cause.toJSON()
        : toTransportError(cause, "The CDEP receiver failed"),
    );
  });

  return {
    started,
    destroy() {
      destroyed = true;
      transport?.destroy();
    },
  };
}

async function guard<T>(context: string, action: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await action();
  } catch (cause) {
    return { ok: false, error: toTransportError(cause, context) };
  }
}

function validateAcceptAck(payload: unknown): Result<AcceptAck> {
  if (!isPlainObject(payload)) return fail("INTERNAL", "accept: malformed acknowledgement");
  const transferId = payload.transferId;
  const acceptedAt = payload.acceptedAt;
  if (
    typeof transferId !== "string" ||
    typeof acceptedAt !== "number" ||
    !Number.isFinite(acceptedAt)
  ) {
    return fail("INTERNAL", "accept: malformed acknowledgement");
  }
  return ok({ transferId, acceptedAt });
}

function stripInviteFromLocation(receiverWindow: Window): void {
  const url = new URL(receiverWindow.location.href);
  url.hash = stripInvite(url.hash);
  receiverWindow.history.replaceState(receiverWindow.history.state, "", url.href);
}
