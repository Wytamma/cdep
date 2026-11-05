# CDEP protocol v0.3 (draft)

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

A capabilities payload carries `protocol: "cdep"` and `version: 3`. A peer MUST
reject any other protocol name (`PROTOCOL_MISMATCH`) or version
(`VERSION_UNSUPPORTED`) before exchanging offers. Versions are not negotiated:
an implementation either supports version 3 or refuses the session.

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
  version: 3;
  application: { name: string; url?: string };
  imports: FormatCapability[];
  exports: FormatCapability[];
}

interface FormatCapability {
  id: string;              // e.g. org.cdep.format.newick.v1
  label?: string;          // display only
  mediaTypes?: string[];
  extensions?: string[];
  maxBytes?: number;       // cumulative size of this format's files
  maxFiles?: number;       // 1–16 files of this format
  maxFileBytes?: number;   // per-file size, positive integer
  schema?: { id: string; version: number };
}
```

| Field                  | Rule                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `application.name`     | Non-empty, ≤ 200 characters. Display only.                       |
| `application.url`      | Absolute http(s) URL. Informational; never used for trust.       |
| `format.id`            | Lowercase `[a-z0-9-]` segments, at least one dot, ≤ 200 chars.    |
| `maxBytes`             | Positive safe integer, applies to this format's cumulative bytes. |
| `maxFiles`             | Integer 1–16, applies to files of this format.                    |
| `maxFileBytes`         | Positive safe integer, applies to each individual file.          |
| Duplicate capabilities | Rejected: one identifier appears once per direction.             |
| List sizes             | ≤ 512 entries per direction; ≤ 16 media types / extensions each. |

### 4.1 Offer

```ts
interface Offer {
  offerId: string;     // 8–128 chars of [A-Za-z0-9._:-]
  transferId: string;  // 8–128 chars, same alphabet, unique per session
  dataset: {
    name: string;          // bundle name, 1–200 chars, no control characters
    sizeBytes: number;     // total, must equal the sum of file sizes
    files: Array<{
      name: string;        // 1–200 chars, unique within the bundle
      formatId: string;    // every file carries its own format
      sizeBytes: number;
      mediaType?: string;
      schema?: { id: string; version: number };
      metadata?: JsonValue; // arbitrary JSON, optional
    }>;
  };
  sender: { origin: string; application: string };
  issuedAt: number;    // epoch ms
  expiresAt: number;   // epoch ms; issuedAt < expiresAt ≤ issuedAt + 1h
}
```

A bundle may mix formats (for example a Newick tree plus a CSV metadata table).
Format matching and schema checks are per file. A receiver that cannot handle a
mixed bundle (no bundle-level import path) MUST reject the offer with
`NO_COMMON_FORMAT` before consent.

`sender.origin` must equal the origin the receiver observed on the transport. It
exists for display and cross-checking; a mismatch is a hard failure
(`ORIGIN_MISMATCH`).

### 4.2 File metadata

Any file may carry an optional `metadata` value of arbitrary JSON. It has no
required structure, but it must be **JSON**, not arbitrary JavaScript. A peer
MUST reject (with `OFFER_INVALID` or `PAYLOAD_INVALID`):

- functions, symbols, bigints, `undefined`, non-finite numbers, `Date`, `Map`,
  `Set`, class instances, sparse arrays, or accessor-backed properties;
- nesting deeper than 8, more than 64 keys in an object, more than 256 array
  entries, strings longer than 4096 characters, or metadata whose canonical
  JSON exceeds **16 KiB per file**;
- objects containing `__proto__`, `constructor`, or `prototype` keys.

`sizeBytes` counts file data only; metadata is bounded separately. The transfer
request MUST repeat the exact metadata accepted in the offer (object key order
is irrelevant, comparison is over canonical JSON); a mismatch is
`PAYLOAD_INVALID`. Receivers MUST treat metadata as untrusted data and MUST NOT
render it as HTML.

## 5. Operations

| # | Operation            | Called by | Request | Success value |
| - | -------------------- | --------- | ------- | ------------- |
| 1 | `getCapabilities()`  | Sender    | —       | `Capabilities` |
| 2 | `offer(offer)`       | Sender    | `Offer` | `{ offerId, transferId, state: "OFFERED", expiresAt }` |
| 3 | `accept(request)`    | Receiver  | `{ offerId }` | `{ transferId, acceptedAt }` |
| 4 | `transfer(request)`  | Sender    | `{ transferId, sizeBytes, files: Array<{ name, formatId, sizeBytes, metadata?, data: string \| ArrayBuffer }> }` | `Receipt` |
| 5 | `getStatus(request)` | Sender    | `{ transferId }` | `TransferStatus` |
| 6 | `cancel(request)`    | Either    | `{ transferId, reason? }` | `{ transferId, cancelled }` |

`Receipt` is
`{ transferId, state: "IMPORTED", importedAt, sizeBytes, fileCount, formats: string[] }`.
`TransferStatus` is `{ transferId, state, updatedAt, error?, receipt? }`.

Operations 3 and 6 are exposed by the sender; the receiver calls them. All
others are exposed by the receiver.

## 6. Flow

1. The sender reads the destination URL supplied by the user, opens it, and
   completes the invitation handshake ([discovery.md](./discovery.md)).
2. Both sides connect with the exact origin verified during that handshake.
3. Sender calls `getCapabilities()` and validates the response.
4. The sender either selects one exact-identifier format or takes a named bundle
   export whose files name their own formats. Every file is matched against a
   receiver import capability; schemas and limits are checked per file.
5. Sender calls `offer(offer)` with the bundle descriptor.
6. The receiver validates the offer and asks the human: bundle name, total
   size, every file name with its format and size, and the verified sender
   origin MUST all be shown.
7. On approval, the receiver calls `accept({ offerId })` on the sender. Only
   after the sender acknowledges does `offer` return its `OfferAck`.
   - Rationale: one approval path, one transfer id, and an explicit acceptance
     operation that a human can audit in a log.
   - The sender MUST NOT transfer before its `accept` handler has run.
8. Sender calls `transfer(...)` with every file in the bundle.
9. The receiver re-validates the file set, per-file formats and sizes, per-format
   limits, total, and state, then imports the bundle and returns a `Receipt`.

`offer()` MAY therefore stay pending for as long as the offer is valid. A
receiver that cannot obtain consent returns `REJECTED`.

### 6.1 Rules

- A transfer MUST be initiated by an explicit user action in the sending
  application. Discovery alone authorises nothing.
- A bundle MUST contain 1–16 files with unique names; the total declared size
  MUST equal the sum of the file sizes; every file MUST declare a format.
- A receiver MUST reject a payload whose file set differs from the accepted
  offer, including extra, missing, renamed, re-formatted files, or changed file
  metadata (`PAYLOAD_INVALID`).
- File metadata MUST be JSON, bounded as in §4.2, and MUST NOT be rendered as
  HTML.
- A receiver MUST enforce `maxFileBytes` per file, `maxBytes` per format
  cumulative, and its own absolute total (`SIZE_EXCEEDED`), plus `maxFiles` per
  format and the protocol-wide 16-file ceiling (`FILE_COUNT_EXCEEDED`).
- A receiver without a bundle-level import path MUST reject an offer that mixes
  formats (`NO_COMMON_FORMAT`) before consent.
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
| `SIZE_EXCEEDED` | Payload, a file, or the bundle exceeds a declared limit. |
| `FILE_COUNT_EXCEEDED` | The bundle contains more files than the receiver accepts. |
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

## 9. Non-goals for v0.3

- WebRTC or any peer-to-peer transport.
- Automatic format conversion or semantic inference.
- Per-file *selection*: the sender chooses the bundle, not the receiver.
- Background transfers without a human gesture and approval.
- Streaming, chunking, or multi-gigabyte payloads.
- Persistent sessions or resumption after navigation.
- Establishing the sender's identity: authenticity is not part of v0.3.

## 10. Conformance checklist

1. Validate every inbound structure before use.
2. Pin the exact verified origin; never use a wildcard.
3. Require an explicit user action to send and a positive approval to accept.
4. Enforce size limits before allocating or copying the payload, per file and
   in total.
5. Reject a file set that differs from the accepted offer, including format
   changes.
6. Match formats and schemas per file; require a bundle path for mixed bundles.
7. Report failures with the codes above.
8. Treat format identifiers as opaque, versioned strings.
9. Strip the invitation nonce after the handshake and never accept it twice.
