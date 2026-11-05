import { CdepException, cdepError, type CdepError } from "@cdep/protocol";

const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
  "::1": true,
};

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS[hostname] === true;
}

/**
 * HTTPS is mandatory except on loopback, where browsers treat the origin as
 * secure and development/testing needs no certificates.
 */
export function isTransportAllowedByPolicy(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

function policyError(code: CdepError["code"], message: string, details?: Record<string, unknown>): CdepException {
  return new CdepException(cdepError(code, message, details));
}

/**
 * Validates the destination the user asked to send to. The returned URL is
 * what gets opened; callers must not re-derive the origin separately.
 */
export function assertTransferTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw policyError("TARGET_URL_INVALID", "The destination is not a valid absolute URL", {
      received: rawUrl,
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw policyError("TARGET_URL_INVALID", "Destination URLs must not contain credentials");
  }
  if (!isTransportAllowedByPolicy(url)) {
    throw policyError(
      "HTTPS_REQUIRED",
      "CDEP requires HTTPS; plain HTTP is accepted only on localhost and 127.0.0.1",
      { origin: url.origin, protocol: url.protocol },
    );
  }
  if (url.origin === "null") {
    throw policyError("TARGET_URL_INVALID", "The destination has an opaque origin");
  }
  return url;
}

/**
 * A peer origin verified from a message event still has to satisfy transport
 * policy: a plain-HTTP page on the public internet must not be a CDEP peer.
 */
export function assertPeerOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw policyError("ORIGIN_MISMATCH", "Peer origin is not a valid URL origin", { origin });
  }
  if (url.origin !== origin || origin === "null") {
    throw policyError("ORIGIN_MISMATCH", "Peer origin is opaque or not normalized", { origin });
  }
  if (!isTransportAllowedByPolicy(url)) {
    throw policyError("HTTPS_REQUIRED", "Peer origin does not satisfy CDEP transport policy", {
      origin,
    });
  }
  return origin;
}
