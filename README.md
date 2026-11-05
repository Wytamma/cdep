# CDEP — Client Data Exchange Protocol

Capability discovery, user-approved dataset transfer, and receipts between two
browser applications. No backend, no shared code, no prior knowledge of each
other.

Status: v0.1 draft. Browser-only. Ships a TypeScript SDK, a wire specification,
and two independently hosted reference applications.

## How it works

```
Sequence App (origin A)                         Tree Viewer (origin B)
──────────────────────                         ──────────────────────
sendTo("http://localhost:5182/")
  ├─ open B with #cdep=1&cdep-sid=<nonce>
  ├─ raw postMessage hello/hello-ack      →    verify source === opener
  │                                            take origin from event.origin
  │                                            strip nonce, connect
  ├─ getCapabilities()                    →    {newick import, …}
  ├─ negotiate exact format ids
  ├─ offer(dataset)                       →    validate, then ask the human
  │                                            shows name, format, size, origin
  ├─ accept({offerId})                    ←    only after approval
  ├─ transfer(text or ArrayBuffer)        →    re-validate size, import
  └─ Receipt {state:"IMPORTED"}           ←
```

Penpal carries the calls; CDEP owns discovery, negotiation, consent, validation,
lifecycle, and error codes. Another stack can implement the same protocol over
raw `postMessage`.

The receiving page opens as a normal tab (`window.open` with no window
features) and stays open as the working application after the import; the
sender must not close it on success.

## Repository layout

```
packages/protocol   wire types, validators, negotiation, state machine (no DOM)
packages/browser    handshake, Penpal transport, sender, receiver, consent, bridge
packages/formats    proposed format identifiers and registry
examples/sequence-app   exports Newick + FASTA, imports FASTA (tree draft is editable)
examples/tree-viewer    starts empty; loads a Newick file or receives one, renders SVG, exports Newick
specification/      protocol, discovery, security, format registry
tests/e2e           Playwright, two loopback origins, three engines
```

## Quick start

```ts
import { createBridge } from "@cdep/browser";
import { NEWICK_V1, normalizeFormatKey, registryCapability } from "@cdep/formats";

const bridge = createBridge({
  application: { name: "Tree Viewer" },
  normalizeFormatKey,
  imports: {
    [NEWICK_V1]: async (dataset) => {
      // dataset.data is a string or an ArrayBuffer; validate it yourself.
      loadTree(String(dataset.data));
    },
  },
  exports: {
    [NEWICK_V1]: () => ({ data: serializeTree(), name: "tree.newick" }),
  },
  importCapabilities: { [NEWICK_V1]: registryCapability(NEWICK_V1) },
});

// Must be called from a user gesture: the SDK opens the receiving tab synchronously.
await bridge.sendTo("https://treeviewer.example/app", { format: "newick" });
```

A page opened with `#cdep=1&cdep-sid=…` starts the receiver automatically; the
application page itself is the receiver, so adapters see real application state.
No extra HTML entry is required.

### `createBridge(options)`

| Option | Purpose |
| --- | --- |
| `application` | `{name, url?}` shown to the other side. Display only. |
| `imports` / `exports` | Adapters keyed by registry alias or full identifier. |
| `importCapabilities` / `exportCapabilities` | Optional per-format limits, labels, schemas. |
| `normalizeFormatKey` | Maps aliases to identifiers (pass `normalizeFormatKey` from `@cdep/formats`). |
| `maxBytes` | Absolute ceiling for what this app sends or accepts (default 10 MB). |
| `onTransferRequest` | Replace the built-in consent dialog. Must show the same facts; anything but `true` declines. |
| `onState` / `onError` | Receiver progress and failure reporting for the app's UI. |
| `handshakeTimeoutMs`, `connectTimeoutMs`, `offerTtlMs`, `methodTimeoutMs` | Deadlines. |

Returns `{capabilities, receiver, sendTo, destroy}`. `sendTo` throws a
`CdepException` carrying a protocol `code` and optional `details`; it resolves
with a `Receipt` only after the receiver imported the dataset.

Sender-side ambiguity is an error, not a guess: with several compatible formats
and no `format` option, `sendTo` rejects with `AMBIGUOUS_FORMAT` and lists the
candidate identifiers.

## Run the demos

```sh
pnpm install
pnpm build            # packages emit dist/; the demos import it
pnpm --filter @cdep/example-sequence-app dev     # http://127.0.0.1:5181
pnpm --filter @cdep/example-tree-viewer dev      # http://localhost:5182
```

Different hostnames and ports, so every demo transfer is cross-origin. Static
hosting is enough; nothing talks to a server.

Sequence App's Newick draft is editable: the textarea is what gets exported, and
the sender refuses an obviously malformed draft before opening a window. That
check is structural only — Tree Viewer performs the real parse — which is
exactly the division of responsibility CDEP assumes.

Tree Viewer starts with no tree. You can load a `.nwk`/`.newick`/`.tree` file
with its file input, or receive one from Sequence App; the Send panel stays
disabled until a tree exists.

Fixtures for the failure paths:

- choose **FASTA** in Sequence App → Tree Viewer has no FASTA import →
  `NO_COMMON_FORMAT`;
- open `http://127.0.0.1:5181/?fixture=oversize` → the Newick export exceeds the
  10 MB ceiling → `SIZE_EXCEEDED`.

## Verify

```sh
pnpm typecheck        # packages + demo apps, no emit
pnpm test             # 160 Vitest tests, no DOM required
pnpm e2e              # Chromium, Firefox, WebKit on two loopback origins
```

The e2e suite covers: approved cross-origin transfer (asserts the imported tree,
the receipt, the consent facts, and that the nonce is stripped), declined
transfer, incompatible format, oversize payload, and a receiver page used
normally without an invitation.

## Acceptance status (v0.1)

| Criterion | Status |
| --- | --- |
| Two apps on different origins connect | ✅ e2e (loopback HTTP; see policy below) |
| A discovers B's capabilities without a server | ✅ e2e |
| Exact matching format identified automatically | ✅ e2e + unit |
| Incompatible format rejected before transfer | ✅ e2e |
| User can approve or reject | ✅ e2e |
| Valid Newick imports correctly | ✅ e2e |
| Unexpected origins rejected | ✅ unit (source check, exact `allowedOrigins`, origin cross-check) |
| Invalid schemas, excess sizes, expired sessions fail safely | ✅ unit + e2e (size) |
| Blocked windows / incompatible opener policies produce clear errors | ✅ codes implemented; not e2e (Playwright cannot block `window.open`, and COOP needs a separate deployment) |
| Chrome, Firefox, Safari | ✅ Chromium, Firefox, WebKit e2e |

Transport policy: HTTPS everywhere except `localhost`, `127.0.0.1`, and `[::1]`,
so development and tests need no certificates. This is a deliberate, documented
exception to "HTTPS only".

## Security in one paragraph

The receiver never releases data on discovery alone. Before approval it sees the
dataset name, exact format, byte size, and the sender's **verified** origin (not
a claim). Origins are authenticated from `MessageEvent.origin`, bound to
`window.opener`, and pinned as the only allowed origin; the invitation nonce is
single-use and stripped from the URL. Every inbound structure is validated,
sizes are checked twice, and binary exports are copied so the sender's memory is
never detached. There is no sender identity, no payload signature, and no
confidentiality from the receiver's own origin. Read
[specification/security.md](./specification/security.md) before deploying.

## Documentation

- [specification/protocol.md](./specification/protocol.md) — operations, schemas,
  state machine, error codes.
- [specification/discovery.md](./specification/discovery.md) — invitation,
  handshake, failure modes, implementing without Penpal.
- [specification/security.md](./specification/security.md) — threat model,
  controls, residual risks.
- [specification/format-registry.md](./specification/format-registry.md) —
  identifiers, matching, schemas.

## Out of scope for v0.1

WebRTC, format conversion, unattended transfers, chunking/streaming, persistent
sessions, SDKs for other languages, cloud storage, a global application
directory, and sender authenticity.

## License

MIT
