import { CallOptions } from "penpal";
import {
  CdepException,
  cdepError,
  fail,
  isPlainObject,
  negotiate,
  ok,
  payloadByteLength,
  selectMatch,
  toTransferableBuffer,
  validateAcceptRequest,
  validateCancelRequest,
  validateCapabilities,
  validateOffer,
  type AcceptAck,
  type Capabilities,
  type CdepError,
  type ExportValue,
  type Offer,
  type OfferAck,
  type Receipt,
  type Result,
} from "@cdep/protocol";
import { createInviteUrl, waitForHelloAck } from "./handshake.js";
import { randomId } from "./ids.js";
import { assertTransferTarget } from "./policy.js";
import { readRemoteResult, transportException } from "./result.js";
import { openTransport, type Transport } from "./transport.js";
import type { ReceiverWire, SenderWire } from "./wire.js";

export interface SenderRun {
  targetUrl: string;
  formatId?: string;
  signal?: AbortSignal;
  capabilities: Capabilities;
  applicationName: string;
  exportFor: (formatId: string) => Promise<ExportValue>;
  maxBytes: number;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  offerTtlMs: number;
  methodTimeoutMs: number;
}

/**
 * Runs one sender-initiated, user-approved transfer.
 *
 * `window.open` must be called synchronously: browsers require a user gesture,
 * so nothing may be awaited before the receiving window is created. No window
 * features are requested, so the browser opens the receiver as a normal tab
 * (or a normal window, per the user's settings) rather than a small popup.
 */
export async function sendDataset(run: SenderRun): Promise<Receipt> {
  const target = assertTransferTarget(run.targetUrl);
  if (run.signal?.aborted) {
    throw new CdepException(cdepError("CANCELLED", "The transfer was cancelled before it started"));
  }

  const senderWindow = globalThis.window;
  if (!senderWindow) {
    throw new CdepException(cdepError("INTERNAL", "CDEP transfers require a browser window"));
  }

  const sid = randomId();
  const receiverWindow = senderWindow.open(createInviteUrl(target, sid), `cdep-${sid}`);
  if (!receiverWindow) {
    throw new CdepException(
      cdepError("POPUP_BLOCKED", "The browser blocked the CDEP receiving window", {
        target: target.origin,
      }),
    );
  }

  const decision = Promise.withResolvers<Result<AcceptAck>>();
  let offer: Offer | undefined;
  let accepted = false;
  let transport: Transport<ReceiverWire> | undefined;
  let stopWatch: (() => void) | undefined;

  const methods: SenderWire = {
    async accept(input) {
      const parsed = validateAcceptRequest(input);
      if (!parsed.ok) return parsed;
      if (!offer) return fail("OFFER_UNKNOWN", "No offer is pending");
      if (parsed.value.offerId !== offer.offerId) {
        return fail("OFFER_UNKNOWN", "Unknown offer", { offerId: parsed.value.offerId });
      }
      if (parsed.value.formatId !== offer.dataset.formatId) {
        return fail("SCHEMA_MISMATCH", "Accepted format does not match the offer", {
          offered: offer.dataset.formatId,
          accepted: parsed.value.formatId,
        });
      }
      if (accepted) return fail("TRANSFER_STATE_INVALID", "The offer was already accepted");

      accepted = true;
      const ack: AcceptAck = { transferId: offer.transferId, acceptedAt: Date.now() };
      decision.resolve(ok(ack));
      return ok(ack);
    },
    async cancel(input) {
      const parsed = validateCancelRequest(input);
      if (!parsed.ok) return parsed;
      decision.resolve(fail("CANCELLED", "The receiving application cancelled the transfer"));
      return ok({ transferId: parsed.value.transferId, cancelled: true });
    },
  };

  try {
    await waitForHelloAck({
      receiverWindow,
      expectedOrigin: target.origin,
      sid,
      timeoutMs: run.handshakeTimeoutMs,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      window: senderWindow,
    });

    transport = await openTransport<ReceiverWire>({
      remoteWindow: receiverWindow,
      allowedOrigin: target.origin,
      channel: sid,
      timeoutMs: run.connectTimeoutMs,
      methods,
    });
    const remote = transport.remote;

    const capabilitiesResult = readRemoteResult(
      await remote.getCapabilities(),
      validateCapabilities,
      "getCapabilities",
    );
    if (!capabilitiesResult.ok) throw new CdepException(capabilitiesResult.error);
    const remoteCapabilities = capabilitiesResult.value;

    const matches = negotiate(run.capabilities.exports, remoteCapabilities.imports, {
      ...(run.formatId === undefined ? {} : { requestedFormat: run.formatId }),
    });
    if (!matches.ok) throw new CdepException(matches.error);
    const chosen = selectMatch(matches.value);
    if (!chosen.ok) throw new CdepException(chosen.error);
    const match = chosen.value;

    const exported = await run.exportFor(match.formatId);
    const payload = toTransferableBuffer(exported.data);
    const sizeBytes = payloadByteLength(payload.data);
    const limit = Math.min(match.maxBytes ?? Number.POSITIVE_INFINITY, run.maxBytes);
    if (sizeBytes > limit) {
      throw new CdepException(
        cdepError("SIZE_EXCEEDED", "The dataset exceeds the negotiated size limit", {
          formatId: match.formatId,
          sizeBytes,
          maxBytes: limit,
        }),
      );
    }

    const issuedAt = Date.now();
    offer = {
      offerId: randomId(),
      transferId: randomId(),
      dataset: {
        formatId: match.formatId,
        name: exported.name ?? defaultDatasetName(run.capabilities, match.formatId),
        sizeBytes,
        ...(exported.mediaType === undefined ? {} : { mediaType: exported.mediaType }),
        ...(exported.schema === undefined ? {} : { schema: exported.schema }),
      },
      sender: { origin: senderWindow.location.origin, application: run.applicationName },
      issuedAt,
      expiresAt: issuedAt + run.offerTtlMs,
    };
    const proposed = offer;
    const selfCheck = validateOffer(proposed);
    if (!selfCheck.ok) throw new CdepException(selfCheck.error);

    stopWatch = watchSession({
      receiverWindow,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      timeoutMs: run.offerTtlMs,
      onFailure: (cause) => decision.resolve({ ok: false, error: cause }),
    });

    const offered = readRemoteResult(
      await remote.offer(
        proposed,
        new CallOptions({ timeout: run.offerTtlMs + run.methodTimeoutMs }),
      ),
      (value) => validateOfferAck(value, proposed),
      "offer",
    );
    if (!offered.ok) throw new CdepException(offered.error);

    const outcome = await decision.promise;
    if (!outcome.ok) throw new CdepException(outcome.error);
    stopWatch();
    stopWatch = undefined;

    const receipt = readRemoteResult(
      await remote.transfer(
        {
          transferId: proposed.transferId,
          formatId: proposed.dataset.formatId,
          sizeBytes,
          ...(proposed.dataset.mediaType === undefined
            ? {}
            : { mediaType: proposed.dataset.mediaType }),
          data: payload.data,
        },
        new CallOptions({
          transferables: payload.buffer ? [payload.buffer] : [],
          timeout: run.methodTimeoutMs,
        }),
      ),
      (value) => validateReceipt(value, proposed),
      "transfer",
    );
    if (!receipt.ok) throw new CdepException(receipt.error);

    // The receiving tab stays open: it now owns the imported dataset.
    return receipt.value;
  } catch (cause) {
    receiverWindow.close();
    throw cause instanceof CdepException ? cause : transportException(cause, "The transfer failed");
  } finally {
    stopWatch?.();
    transport?.destroy();
  }
}

interface SessionWatchOptions {
  receiverWindow: Window;
  signal?: AbortSignal;
  timeoutMs: number;
  onFailure: (error: CdepError) => void;
}

/**
 * Fails the pending decision when the sender's counterpart disappears: the
 * user closed the receiving tab, cancelled, or the offer expired.
 */
function watchSession(options: SessionWatchOptions): () => void {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const failWith = (error: CdepError): void => {
    if (stopped) return;
    stop();
    options.onFailure(error);
  };

  function onAbort(): void {
    failWith(cdepError("CANCELLED", "The transfer was cancelled"));
  }

  interval = setInterval(() => {
    if (options.receiverWindow.closed) {
      failWith(cdepError("POPUP_CLOSED", "The receiving window was closed"));
    }
  }, 250);
  timer = setTimeout(
    () => failWith(cdepError("TIMED_OUT", "The offer expired before a decision was made")),
    options.timeoutMs,
  );

  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return stop;
}

function defaultDatasetName(capabilities: Capabilities, formatId: string): string {
  const capability = capabilities.exports.find((candidate) => candidate.id === formatId);
  return `${capability?.label ?? formatId} dataset`;
}

function validateOfferAck(payload: unknown, expected: Offer): Result<OfferAck> {
  if (!isPlainObject(payload)) return fail("OFFER_INVALID", "offer: malformed acknowledgement");
  if (payload.offerId !== expected.offerId) return fail("OFFER_INVALID", "offer: offerId mismatch");
  if (payload.transferId !== expected.transferId) {
    return fail("OFFER_INVALID", "offer: transferId mismatch");
  }
  if (payload.state !== "OFFERED") return fail("OFFER_INVALID", "offer: unexpected state");
  const expiresAt = payload.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return fail("OFFER_INVALID", "offer: invalid expiry");
  }
  if (expiresAt > expected.expiresAt) {
    return fail("OFFER_INVALID", "offer: expiry exceeds the proposed offer");
  }
  return ok({
    offerId: expected.offerId,
    transferId: expected.transferId,
    state: "OFFERED",
    expiresAt,
  });
}

function validateReceipt(payload: unknown, offer: Offer): Result<Receipt> {
  if (!isPlainObject(payload)) return fail("INTERNAL", "transfer: malformed receipt");
  if (payload.state !== "IMPORTED") {
    return fail("IMPORT_FAILED", "transfer: the dataset was not imported", {
      received: payload.state,
    });
  }
  if (payload.transferId !== offer.transferId) {
    return fail("INTERNAL", "transfer: transferId mismatch");
  }
  if (payload.formatId !== offer.dataset.formatId) {
    return fail("INTERNAL", "transfer: formatId mismatch");
  }
  if (payload.sizeBytes !== offer.dataset.sizeBytes) {
    return fail("INTERNAL", "transfer: receipt size does not match the offer");
  }
  const importedAt = payload.importedAt;
  if (typeof importedAt !== "number" || !Number.isFinite(importedAt)) {
    return fail("INTERNAL", "transfer: invalid import timestamp");
  }
  return ok({
    transferId: offer.transferId,
    formatId: offer.dataset.formatId,
    state: "IMPORTED",
    importedAt,
    sizeBytes: offer.dataset.sizeBytes,
  });
}
