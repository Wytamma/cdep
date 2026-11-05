# Security model

CDEP moves user data between two independently operated web applications. The
receiver is the party at risk: it is asked to interpret bytes produced by a
stranger. v0.1 therefore assumes:

- the **sender is untrusted**;
- the **receiver's origin and code are trusted by the receiver's own user**;
- the browser authenticates origins; CDEP never invents identity;
- TLS protects the channel; CDEP adds no confidentiality of its own.

## 1. Threat table

| Threat | Control | Residual risk |
| --- | --- | --- |
| A page opens a CDEP receiver and silently extracts its data | Receiver requires explicit user approval with dataset name, format, size, and verified origin; `accept` is only called after that decision. | A user can approve a malicious transfer. |
| A hostile receiver phishes the sender | Sender shows the destination origin before/while opening; no credentials, cookies, or local data are sent during discovery; nothing is released until the receiver approves. | The receiving tab is still a separate window; users must read the origin. |
| A third window injects messages into an active session | The bootstrap accepts only `event.source === window.opener` with a matching 128-bit nonce; the transport pins the verified origin and the nonce-derived channel. | Compromise of either origin's code, or a browser extension, defeats this. |
| Origin spoofing in metadata | The receiver compares `offer.sender.origin` with the origin observed on the transport; disagreement is `ORIGIN_MISMATCH`. The consent dialog displays only the verified origin. | Claimed `application.name` remains unverified text. |
| Replaying an invitation | Nonce is single-use, bound to one channel, stripped from the URL after the handshake; offers expire; a transfer id cannot be reused. | A captured nonce is useless without the opener window; no replay window is open in the reference implementation. |
| Oversized payloads or memory exhaustion | Sender advertises and enforces limits; receiver checks the declared size **before** consent and re-measures the actual payload; absolute caps on capability lists and metadata lengths; one message per transfer. | No streaming, no rate limiting: many small offers are not throttled in v0.1. |
| Detaching the sender's own buffer | The SDK copies binary exports into a fresh `ArrayBuffer` before transferring; the application's memory is never detached. | Extra copy up to the size limit. |
| Markup injection through metadata | Dataset names, application names, origins, and error messages are inserted with `textContent`; the dialog lives in a shadow root so host CSS cannot spoof its controls. | Applications must not render payload content as HTML. |
| COOP severs the opener | Detected: the receiver reports `OPENER_UNAVAILABLE`; the sender times out. The SDK never relaxes site isolation. | Sites with strict COOP simply cannot use new-window transport in v0.1. |
| Window blockers | Explicit `POPUP_BLOCKED` before any network or message activity. | Users may not understand why nothing opened. |
| Malformed or hostile protocol data | Every inbound structure is validated (`validateCapabilities`, `validateOffer`, `validateTransferRequest`, `validateCancelRequest`) and unknown fields are dropped, not forwarded. | Validation is structural, not semantic. |
| Import adapter crashes on hostile content | Adapter exceptions become `IMPORT_FAILED`; nothing is retried. | Dataset semantics are the application's responsibility. |

## 2. Origin binding

Three checks must all hold for a session:

1. **Bootstrap source**: `event.source === window.opener` on the receiver, and
   `event.source` equal to the window the sender opened, on the sender side.
2. **Nonce**: `cdep-sid` in the receiver's fragment equals the nonce in the
   hello; the nonce selects the transport channel.
3. **Origin**: taken from `MessageEvent.origin`, then pinned as the only allowed
   origin for the connection. In the reference implementation this is Penpal's
   `allowedOrigins: [verifiedOrigin]` — never `"*"` and never a regex.

The destination's origin is derived from the URL the user typed, after transport
policy checks. The sender refuses any hello-ack from a different origin, which
also covers redirects to another site.

## 3. Consent

The receiving application MUST show, before accepting:

- the dataset name as provided by the sender, escaped;
- the exact format identifier and its human label;
- the exact byte size;
- the sender's verified origin and claimed application name, clearly separated.

The built-in dialog states that a successful handshake does not make the sender
trustworthy. A receiver may replace the dialog, but must keep the same
information and must default to deny on error, timeout, or dismissal.

`accept` is the only path from `OFFERED` to `ACCEPTED`; the state machine
rejects every other transition.

## 4. Data handling rules

- Size is checked from metadata before the payload exists, then measured again
  from the received value; both the offer and the transfer declaration must
  agree.
- Text payloads are measured in UTF-8 bytes without allocating an encoded copy.
- Binary payloads are copied into a new buffer, then transferred, so a hostile
  or careless export adapter cannot cause detachment of live application memory.
- Import adapters receive a plain value (`string` or `ArrayBuffer`) and a
  context object with the transfer id, verified origin, and sender name. They
  must validate semantics themselves.
- The SDK keeps at most 16 transfer records per receiving window and one
  connection per invitation.

## 5. Known gaps (v0.1)

- **No sender identity.** Any page can claim any `application.name`. Only the
  origin is authenticated, and only by the browser.
- **No payload integrity check.** TLS protects transit; there is no signature or
  checksum. A compromised receiver page can accept anything.
- **No confidentiality from the receiver's own origin.** The receiving
  application, and any script it loads, sees the dataset.
- **Same-origin applications are not isolated.** If both apps share an origin,
  browser origin checks cannot distinguish them.
- **No rate limiting or quotas.** A local app can be offered many sessions.
- **No chunking.** Payloads are limited to one message (10 MB default).
- **The invitation fragment is visible to the receiving page.** It contains only
  a random nonce.
- **Browser extensions and compromised pages** are outside the model.

## 6. Implementation guidance

- Keep the receiver page free of third-party scripts; the consent boundary is
  only as strong as the page that renders it.
- Add a Content Security Policy; the SDK needs no `eval`, no inline handlers,
  and no external requests.
- Never log payloads or dataset contents; log codes and sizes.
- Treat all sender-supplied strings as text, never markup.
- Do not auto-approve, batch-approve, or remember approvals for a different
  origin.
