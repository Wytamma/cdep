# CDEP protocol v0.1 (draft)

Status: draft, implemented by `@cdep/protocol` and `@cdep/browser`.
Scope: browser-to-browser dataset transfer between two web applications with no
backend, no shared code, and no prior knowledge of each other.

This document defines the operations and their meaning. Penpal is an
implementation dependency, not part of the standard: another implementation may
use raw `postMessage`, but MUST preserve every rule here and the handshake in
[discovery.md](./discovery.md).

## 1. Roles

| Role     | Responsibility                                                     |
| -------- | ------------------------------------------------------------------ |
| Sender   | Opens the receiving window, discovers formats, offers a dataset.    |
| Receiver | Decides whether to accept, validates the payload, imports it.       |

One application MAY implement both roles. The protocol is asymmetric only in
the direction of the receiving window, not in capabilities.

## 2. Versioning

A capabilities payload carries `protocol: "cdep"` and `version: 1`. A peer MUST
reject any other protocol name (`PROTOCOL_MISMATCH`) or version
(`VERSION_UNSUPPORTED`) before exchanging offers. Versions are not negotiated:
an implementation either supports version 1 or refuses the session.

## 3. Envelope

Every operation returns a `Result` envelope. CDEP methods never reject with a
custom error type; transport failures are the only exceptions and MUST be mapped
to a CDEP code by the local implementation.

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CdepErrorCode; message: string; details?: object } };
```

`message` is for developers. Implementations MUST NOT inject it into HTML
unescaped. `details` is free-form and MAY be logged.

## 4. Data model

```ts
interface Capabilities {
  protocol: "cdep";
  version: 1;
  application: { name: string; url?: string };
  imports: FormatCapability[];
  exports: FormatCapability[];
}

interface FormatCapability {
  id: string;              // e.g. org.cdep.format.newick.v1
  label?: string;          // display only
  mediaTypes?: string[];
  extensions?: string[];
  maxBytes?: number;       // positive integer
  schema?: { id: string; version: number };
}
```

| Field                  | Rule                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `application.name`     | Non-empty, ≤ 200 characters. Display only.                       |
| `application.url`      | Absolute http(s) URL. Informational; never used for trust.       |
| `format.id`            | Lowercase `[a-z0-9-]` segments, at least one dot, ≤ 200 chars.    |
| `maxBytes`             | Positive safe integer. Absent means "no limit declared".         |
| Duplicate capabilities | Rejected: one identifier appears once per direction.             |
| List sizes             | ≤ 512 entries per direction; ≤ 16 media types / extensions each. |

### 4.1 Offer

```ts
interface Offer {
  offerId: string;     // 8–128 chars of [A-Za-z0-9._:-]
  transferId: string;  // 8–128 chars, same alphabet, unique per session
  dataset: {
    formatId: string;
    name: string;      // 1–200 chars, no control characters
    sizeBytes: number; // exact UTF-8 or binary byte length
    mediaType?: string;
    schema?: { id: string; version: number };
  };
  sender: { origin: string; application: string };
  issuedAt: number;    // epoch ms
  expiresAt: number;   // epoch ms; issuedAt < expiresAt ≤ issuedAt + 1h
}
```

`sender.origin` must equal the origin the receiver observed on the transport. It
exists for display and cross-checking; a mismatch is a hard failure
(`ORIGIN_MISMATCH`).

## 5. Operations

| # | Operation            | Called by | Request | Success value |
| - | -------------------- | --------- | ------- | ------------- |
| 1 | `getCapabilities()`  | Sender    | —       | `Capabilities` |
| 2 | `offer(offer)`       | Sender    | `Offer` | `{ offerId, transferId, state: "OFFERED", expiresAt }` |
| 3 | `accept(request)`    | Receiver  | `{ offerId, formatId }` | `{ transferId, acceptedAt }` |
| 4 | `transfer(request)`  | Sender    | `{ transferId, formatId, sizeBytes, mediaType?, data: string \| ArrayBuffer }` | `Receipt` |
| 5 | `getStatus(request)` | Sender    | `{ transferId }` | `TransferStatus` |
| 6 | `cancel(request)`    | Either    | `{ transferId, reason? }` | `{ transferId, cancelled }` |

`Receipt` is `{ transferId, formatId, state: "IMPORTED", importedAt, sizeBytes }`.
`TransferStatus` is `{ transferId, state, updatedAt, error?, receipt? }`.

Operations 3 and 6 are exposed by the sender; the receiver calls them. All
others are exposed by the receiver.

## 6. Flow

1. The sender reads the destination URL supplied by the user, opens it, and
   completes the invitation handshake ([discovery.md](./discovery.md)).
2. Both sides connect with the exact origin verified during that handshake.
3. Sender calls `getCapabilities()` and validates the response.
4. The sender intersects its exports with the receiver's imports, selects
   exactly one exact-identifier match, and calls the selected export adapter.
5. Sender calls `offer(offer)`.
6. The receiver validates the offer and asks the human: dataset name, format,
   size, and verified sender origin MUST all be shown.
7. On approval, the receiver calls `accept({ offerId, formatId })` on the
   sender. Only after the sender acknowledges does `offer` return its
   `OfferAck`.
   - Rationale: one approval path, one transfer id, and an explicit acceptance
     operation that a human can audit in a log.
   - The sender MUST NOT transfer before its `accept` handler has run.
8. Sender calls `transfer(...)` with the payload.
9. The receiver re-validates size, format and state, runs the import adapter,
   and returns a `Receipt`.

`offer()` MAY therefore stay pending for as long as the offer is valid. A
receiver that cannot obtain consent returns `REJECTED`.

### 6.1 Rules

- A transfer MUST be initiated by an explicit user action in the sending
  application. Discovery alone authorises nothing.
- A receiver MUST reject a payload whose received byte count differs from both
  the offer and the transfer declaration (`PAYLOAD_SIZE_MISMATCH`).
- A receiver MUST refuse a second payload for a transfer id that is no longer
  `ACCEPTED` (`TRANSFER_STATE_INVALID`).
- Offers are single-use and expire. Expired offers MUST NOT be accepted or
  fulfilled (`OFFER_EXPIRED`).
- Metadata strings are untrusted display data, never markup.

## 7. State machine

```
CONNECTED
  └─ DISCOVER → CAPABILITIES_DISCOVERED
       └─ OFFER → OFFERED
            ├─ ACCEPT → ACCEPTED
            │    └─ TRANSFER_START → TRANSFERRING
            │         └─ TRANSFER_COMPLETE → IMPORTED
            └─ REJECT → REJECTED
```

From any non-terminal state: `FAIL → FAILED`, `CANCEL → CANCELLED`,
`TIMEOUT → TIMED_OUT`. `REJECT` is legal only in `OFFERED`. All of `IMPORTED`,
`REJECTED`, `FAILED`, `CANCELLED`, `TIMED_OUT` are terminal. Implementations
MUST reject illegal transitions with `TRANSFER_STATE_INVALID`.

## 8. Error codes

| Code | Meaning |
| --- | --- |
| `TARGET_URL_INVALID` | Destination is not a usable absolute URL. |
| `HTTPS_REQUIRED` | Transport policy violated (HTTPS required; HTTP only on loopback). |
| `POPUP_BLOCKED` | The browser refused to open the receiver window. |
| `POPUP_CLOSED` | The receiver window closed before completion. |
| `OPENER_UNAVAILABLE` | An invitation arrived without a usable opener (e.g. COOP). |
| `HANDSHAKE_FAILED` | Channel could not be established or a method was missing. |
| `HANDSHAKE_TIMEOUT` | No handshake or reply within the deadline. |
| `ORIGIN_MISMATCH` | Claimed or observed origin violates the session. |
| `PROTOCOL_MISMATCH` | Peer did not speak CDEP. |
| `VERSION_UNSUPPORTED` | Peer speaks a different CDEP version. |
| `CAPABILITIES_INVALID` | Capabilities failed schema validation. |
| `NO_COMMON_FORMAT` | No exact format match. |
| `AMBIGUOUS_FORMAT` | Several matches and no explicit choice. |
| `SCHEMA_MISMATCH` | Schema or format of a payload disagrees with the offer. |
| `SIZE_EXCEEDED` | Payload exceeds a declared or configured limit. |
| `OFFER_INVALID` | Offer failed schema validation. |
| `OFFER_UNKNOWN` | Unknown offer or transfer id. |
| `OFFER_EXPIRED` | Offer or acceptance window elapsed. |
| `TRANSFER_STATE_INVALID` | Operation illegal in the current state. |
| `PAYLOAD_INVALID` | Payload failed schema validation. |
| `PAYLOAD_SIZE_MISMATCH` | Declared size differs from received bytes. |
| `IMPORT_FAILED` | The receiving application rejected the dataset. |
| `REJECTED` | The human declined. |
| `CANCELLED` | One side cancelled. |
| `TIMED_OUT` | No decision within the deadline. |
| `INTERNAL` | Local bug or malformed peer reply with no better code. |

Transport-specific codes are still part of the protocol: a caller should not
have to parse messages to distinguish a blocked window from a broken dataset.

## 9. Non-goals for v0.1

- WebRTC or any peer-to-peer transport.
- Automatic format conversion or semantic inference.
- Background transfers without a human gesture and approval.
- Streaming, chunking, or multi-gigabyte payloads.
- Persistent sessions or resumption after navigation.
- Establishing the sender's identity: authenticity is not part of v0.1.

## 10. Conformance checklist

1. Validate every inbound structure before use.
2. Pin the exact verified origin; never use a wildcard.
3. Require an explicit user action to send and a positive approval to accept.
4. Enforce size limits before allocating or copying the payload.
5. Report failures with the codes above.
6. Treat format identifiers as opaque, versioned strings.
7. Strip the invitation nonce after the handshake and never accept it twice.
