import { CdepException, cdepError, isPlainObject, type CdepError } from "@cdep/protocol";
import { isSessionId } from "./ids.js";
import { assertPeerOrigin } from "./policy.js";

/**
 * Raw `postMessage` bootstrap that runs before any Penpal connection exists.
 *
 * Penpal's `allowedOrigins` must be configured before a single message is
 * exchanged, but the receiver cannot know the opener's origin without
 * receiving a message. This handshake establishes it: the origin is read from
 * `MessageEvent.origin` and bound to `MessageEvent.source === window.opener`,
 * never from a query string or `document.referrer`.
 */
export const HANDSHAKE_NAMESPACE = "cdep-handshake";
export const INVITE_PARAM = "cdep";
export const SID_PARAM = "cdep-sid";

export type HandshakeMessage =
  | { namespace: typeof HANDSHAKE_NAMESPACE; type: "hello"; sid: string; version: 1 }
  | { namespace: typeof HANDSHAKE_NAMESPACE; type: "hello-ack"; sid: string; version: 1 };

export function createInviteUrl(target: URL, sid: string): string {
  const url = new URL(target.href);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  params.set(INVITE_PARAM, "1");
  params.set(SID_PARAM, sid);
  url.hash = params.toString();
  return url.href;
}

export function parseInvite(hash: string): { sid: string } | undefined {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (params.get(INVITE_PARAM) !== "1") return undefined;
  const sid = params.get(SID_PARAM);
  return isSessionId(sid) ? { sid } : undefined;
}

/** Removes handshake parameters while preserving the application's own hash. */
export function stripInvite(hash: string): string {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  params.delete(INVITE_PARAM);
  params.delete(SID_PARAM);
  const remaining = params.toString();
  return remaining === "" ? "" : `#${remaining}`;
}

export function helloMessage(sid: string): HandshakeMessage {
  return { namespace: HANDSHAKE_NAMESPACE, type: "hello", sid, version: 1 };
}

export function helloAckMessage(sid: string): HandshakeMessage {
  return { namespace: HANDSHAKE_NAMESPACE, type: "hello-ack", sid, version: 1 };
}

export function readHandshakeMessage(value: unknown): HandshakeMessage | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.namespace !== HANDSHAKE_NAMESPACE) return undefined;
  if (value.type !== "hello" && value.type !== "hello-ack") return undefined;
  if (value.version !== 1) return undefined;
  if (!isSessionId(value.sid)) return undefined;
  return {
    namespace: HANDSHAKE_NAMESPACE,
    type: value.type,
    sid: value.sid,
    version: 1,
  };
}

export interface HelloAckOptions {
  receiverWindow: Window;
  expectedOrigin: string;
  sid: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test seam; defaults to the current window. */
  window?: Window;
}

/**
 * Sender side: repeatedly offers the nonce until the receiving tab
 * acknowledges it. Repetition is required because the new tab's document may
 * not exist yet when the first message is posted.
 */
export async function waitForHelloAck(options: HelloAckOptions): Promise<void> {
  const senderWindow = options.window ?? globalThis.window;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;

  let retry: ReturnType<typeof setInterval> | undefined;
  const timer = setTimeout(
    () => fail(cdepError("HANDSHAKE_TIMEOUT", "The receiving application did not answer the CDEP handshake")),
    options.timeoutMs,
  );

  const stop = (): void => {
    clearInterval(retry);
    clearTimeout(timer);
    senderWindow.removeEventListener("message", onMessage);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const fail = (error: CdepError): void => {
    if (settled) return;
    settled = true;
    stop();
    reject(new CdepException(error));
  };

  const succeed = (): void => {
    if (settled) return;
    settled = true;
    stop();
    resolve();
  };

  function onMessage(event: MessageEvent): void {
    if (event.origin !== options.expectedOrigin) return;
    if (event.source !== options.receiverWindow) return;
    const message = readHandshakeMessage(event.data);
    if (!message || message.type !== "hello-ack" || message.sid !== options.sid) return;
    succeed();
  }

  function onAbort(): void {
    fail(cdepError("CANCELLED", "The transfer was cancelled"));
  }

  senderWindow.addEventListener("message", onMessage);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
    return promise;
  }

  const sendHello = (): void => {
    if (settled) return;
    if (options.receiverWindow.closed) {
      fail(cdepError("POPUP_CLOSED", "The receiving window was closed before the handshake"));
      return;
    }
    options.receiverWindow.postMessage(helloMessage(options.sid), options.expectedOrigin);
  };

  retry = setInterval(sendHello, 250);
  sendHello();
  return promise;
}

export interface HelloOptions {
  sid: string;
  timeoutMs: number;
  window?: Window;
}

/**
 * Receiver side: only a message whose source is `window.opener` counts, and
 * the peer origin is taken from that message event.
 */
export async function waitForHello(options: HelloOptions): Promise<{ origin: string }> {
  const receiverWindow = options.window ?? globalThis.window;
  const opener = receiverWindow.opener;
  if (!opener) {
    throw new CdepException(
      cdepError(
        "OPENER_UNAVAILABLE",
        "This window was not opened by a CDEP sender (or the opener was severed by COOP)",
      ),
    );
  }

  const { promise, resolve, reject } = Promise.withResolvers<{ origin: string }>();
  let settled = false;

  const timer = setTimeout(
    () => fail(cdepError("HANDSHAKE_TIMEOUT", "No CDEP sender completed the handshake")),
    options.timeoutMs,
  );

  const stop = (): void => {
    clearTimeout(timer);
    receiverWindow.removeEventListener("message", onMessage);
  };

  const fail = (error: CdepError): void => {
    if (settled) return;
    settled = true;
    stop();
    reject(new CdepException(error));
  };

  function onMessage(event: MessageEvent): void {
    if (event.source !== opener) return;
    const message = readHandshakeMessage(event.data);
    if (!message || message.type !== "hello" || message.sid !== options.sid) return;

    let origin: string;
    try {
      origin = assertPeerOrigin(event.origin);
    } catch (error) {
      fail(error instanceof CdepException ? error.toJSON() : cdepError("ORIGIN_MISMATCH", "Unusable peer origin"));
      return;
    }

    if (settled) return;
    settled = true;
    stop();
    opener.postMessage(helloAckMessage(options.sid), origin);
    resolve({ origin });
  }

  receiverWindow.addEventListener("message", onMessage);
  return promise;
}
