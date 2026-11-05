# Discovery and session bootstrap

v0.3 uses runtime discovery over the message channel. There is no manifest, no
directory, and no `/cdep/receiver.html` endpoint.

## 1. What the user supplies is the destination

`sendTo(targetUrl)` opens **the exact URL the user gave**. It is not rewritten
to an origin root and no path is appended.

That is deliberate. Static applications are commonly served below a path
(`https://example.org/my-app/`, GitHub Pages project sites, previews). Any rule
that derived a receiver URL from the origin would break them, and a convention
such as `/cdep/receiver.html` would force every application to ship a second
HTML entry that cannot see the application's real state.

Consequences:

- The destination must be a page that runs `createBridge()`.
- The user is responsible for entering the participating application's URL; the
  SDK cannot guess it and MUST NOT probe unrelated paths.
- If the URL has an existing fragment (an SPA route), it is preserved.

Presentation: `window.open` is called with no window features, so browsers open
the receiving page as a normal tab (or a normal window, according to user
settings) rather than a small popup. The transfer completes in that window and
it stays open as the working application; the sender must not close it on
success. The protocol does not depend on tab-versus-window presentation, but an
implementation MUST NOT pass features that force a popup-sized window unless its
application explicitly asks for one.

## 2. Invitation

The sender appends two parameters to the fragment:

```
https://treeviewer.example/app#/tree/42  →  https://treeviewer.example/app#/tree/42&cdep=1&cdep-sid=<nonce>
```

| Parameter  | Value                                             |
| ---------- | ------------------------------------------------- |
| `cdep`     | Literal `1`.                                      |
| `cdep-sid` | 32 lowercase hex characters from `crypto.getRandomValues`. |

The fragment is used rather than the query string because it is never sent to
the static host's server and does not appear in access logs or caches.

The nonce is a single-use session identifier: it selects the message channel,
binds the two halves of the bootstrap, and is removed from the URL once the
handshake completes.

## 3. Handshake (before any framework connection)

Penpal (or any transport) needs `allowedOrigins` before it may accept a single
message, but the receiver cannot know the opener's origin from a query string:
a query string is a claim. The bootstrap therefore uses raw `postMessage`:

```
sender (origin A)                          receiver (origin B, target page)
────────────────────────────────────────────────────────────────────────────
open(B#cdep=1&cdep-sid=N)
postMessage({namespace:"cdep-handshake",
             type:"hello", sid:N, version:1}, B)
                                            verify: event.source === window.opener
                                            verify: message namespace/type/version
                                            verify: message.sid === N from location.hash
                                            origin := event.origin        (verified)
                                            postMessage({type:"hello-ack",
                                                         sid:N}, origin)
verify: event.origin === origin(B)
verify: event.source === receiver window
verify: sid === N
history.replaceState(remove cdep, cdep-sid)
connect(channel = N, allowedOrigins = [B])  connect(channel = N, allowedOrigins = [origin])
```

Rules that make this safe:

1. The receiver accepts a hello **only** from `window.opener` (`event.source`),
   never from any window that guesses the nonce.
2. The receiver takes the peer origin from `event.origin`, never from the URL,
   `document.referrer`, or message contents.
3. The nonce must match the nonce in the receiver's own URL fragment, so a
   message from an unrelated window with the right source cannot bind a new
   session.
4. The sender ignores any hello-ack whose origin is not the origin it opened
   and whose source is not the window it opened.
5. Transport policy is applied to the verified origin: HTTPS, or HTTP on
   `localhost` / `127.0.0.1` / `[::1]` only.
6. Both sides then connect with the exact verified origin. A wildcard
   `allowedOrigins` is forbidden.
7. The nonce is stripped with `history.replaceState` before the payload phase,
   so reloading the receiver page cannot replay the invitation.

Retries: the sender re-posts the hello every 250 ms until acknowledged, because
a freshly opened tab has no document to receive the first message. The
receiver treats repeated hellos for the same nonce idempotently (it answers once
and settles).

## 4. Failure modes

| Condition | Result |
| --- | --- |
| Window blocked | `POPUP_BLOCKED` before any message is sent. |
| Destination is not an allowed scheme/origin | `HTTPS_REQUIRED` / `TARGET_URL_INVALID`. |
| Receiver page does not run CDEP | `HANDSHAKE_TIMEOUT` (sender gives up; receiver window closed). |
| COOP severs `window.opener` | Receiver reports `OPENER_UNAVAILABLE`; sender times out. |
| Receiving tab navigates to another origin | Hello-ack origin mismatch; sender times out and never talks to the new origin. |
| User closes the receiving tab | `POPUP_CLOSED` immediately. |
| Receiver is slow to boot | Re-posts every 250 ms until the deadline. |

The SDK never weakens `Cross-Origin-Opener-Policy` to make a transfer work. A
site that isolates itself is incompatible with new-window transport; that is a
product decision for the site, not something the protocol may override.

## 5. Implementing without Penpal

A different transport is conformant if it preserves:

- one channel per nonce, isolated from any other conversation in either window;
- exact-origin send and receive filters, applied to the verified origin;
- source-window checks on the bootstrap messages;
- ordered request/response semantics for the six protocol operations;
- teardown that removes listeners when the session ends.

Nothing in CDEP requires the `Result` envelope to travel inside Penpal messages;
only the shapes in [protocol.md](./protocol.md) are normative.

## 6. Deferred

- A static `cdep.json` manifest naming the receiver URL and formats.
- An application directory or registry of participating sites.
- iframe embedding (would avoid opening a separate tab but needs the receiving
  app to run in a nested browsing context and to accept third-party embedding).
