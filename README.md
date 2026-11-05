# CDEP — Client Data Exchange Protocol

Capability discovery, user-approved dataset transfer, and receipts between two
browser applications. No backend, no shared code, no prior knowledge of each
other.

Status: v0.3 draft. Browser-only. Ships a TypeScript SDK, a wire specification,
and two independently hosted reference applications. Wire version 3 adds
per-file formats and mixed-format bundles; wire version 3 peers only.

## How it works

```
Sequence App (origin A)                         Tree Viewer (origin B)
──────────────────────                         ──────────────────────
sendTo("http://localhost:5182/", { bundle })
  ├─ open B with #cdep=1&cdep-sid=<nonce>
  ├─ raw postMessage hello/hello-ack      →    verify source === opener
  │                                            take origin from event.origin
  │                                            strip nonce, connect
  ├─ getCapabilities()                    →    {newick, csv imports, …}
  ├─ match every file's format + schema
  ├─ offer(bundle: files, formats, sizes) →    validate, then ask the human
  │                                            shows every file, format, origin
  ├─ accept({offerId})                    ←    only after approval
  ├─ transfer(files[])                    →    re-validate sets and sizes
  └─ Receipt {formats, fileCount, bytes}  ←
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
examples/tree-viewer    starts empty; loads Newick files or receives a bundle, renders SVG
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
    [NEWICK_V1]: async (files) => {
      // files: [{ name, formatId, sizeBytes, data: string | ArrayBuffer }]
      for (const file of files) loadTree(file.name, String(file.data));
    },
  },
  exports: {
    [NEWICK_V1]: () => ({
      name: "trees.newick",
      files: [{ name: "tree.nwk", data: serializeTree() }],
    }),
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
| `bundles` | Named mixed-format exports; each file declares its own `formatId`. |
| `importBundle` | Receives a whole bundle; required for bundles that mix formats. |
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

### Bundles

A bundle is 1–16 uniquely named files, and **each file declares its own
format** and may carry free-form JSON `metadata` with no schema:

```ts
bundles: {
  "tree-metadata": () => ({
    name: "tree + metadata",
    files: [
      {
        name: "tree.nwk",
        formatId: NEWICK_V1,
        data: serializeTree(),
        metadata: { source: "sequence-app", tips: 4 },
      },
      {
        name: "metadata.csv",
        formatId: CSV_V1,
        data: tableCsv(),
        metadata: { columns: ["name", "length"] },
      },
    ],
  }),
},
importBundle: (bundle, context) => {
  const tree = bundle.files.find((file) => file.formatId === NEWICK_V1);
  const table = bundle.files.find((file) => file.formatId === CSV_V1);
  render(tree, table);
},
```

- `sendTo(url, { bundle: "tree-metadata" })` sends the named bundle;
  `sendTo(url, { format: "newick" })` keeps the single-format path.
- Every file format must be declared in `exports`; the sender matches each file
  against the receiver's imports and checks schema equality per file.
- Limits are per capability: `maxFileBytes` per file, `maxBytes` for that
  format's cumulative bytes, `maxFiles` for that format's file count, plus the
  bridge-wide total.
- Single-format bundles go to the `imports[format]` adapter with all files of
  that format. Mixed bundles require `importBundle`; a receiver without it
  rejects the offer before consent.
- Per-file `metadata` is arbitrary JSON (no schema), capped at 16 KiB canonical
  JSON per file, depth 8, 64 keys, 256 array entries. The sender repeats it in
  the transfer; the receiver verifies it matches the accepted offer.
- The consent dialog lists every file with its format and size (first eight,
  then "+N more"), plus the total and the verified origin. Metadata is not
  rendered in the dialog; adapters receive it on `ImportedFile.metadata`.

`bundles` is not negotiated by name: the receiver sees formats, not bundle
identifiers, so a bundle id is purely a sender-side label.

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

Tree Viewer starts with no tree. Load one or more `.nwk`/`.newick`/`.tree` files
with its file input, or receive a bundle; the active tree is rendered, every
file is listed, and the send action transfers the whole Newick bundle. It
imports CSV metadata too and renders it as a table.

Sequence App offers three sends: Newick, FASTA, and **Tree + metadata** — a
mixed bundle of `tree.nwk` plus `metadata.csv` generated from the current FASTA
records, each carrying its own JSON metadata. Tree Viewer can forward that same
bundle onward once it has received both parts; it shows each file's metadata in
the bundle list and preserves it on re-export. Sending is disabled in Tree
Viewer while nothing is loaded.

Fixtures for the failure paths:

- choose **FASTA** in Sequence App → Tree Viewer has no FASTA import →
  `NO_COMMON_FORMAT`;
- open `http://127.0.0.1:5181/?fixture=oversize` → the Newick export exceeds the
  10 MB ceiling → `SIZE_EXCEEDED`.

## Verify

```sh
pnpm typecheck        # packages + demo apps, no emit
pnpm test             # 225 Vitest tests, no DOM required
pnpm e2e              # Chromium, Firefox, WebKit on two loopback origins
```

The e2e suite covers: approved cross-origin transfer (asserts the imported tree,
the receipt, the consent facts, and that the nonce is stripped), declined
transfer, incompatible format, oversize payload, a receiver page used normally
without an invitation, a multi-file same-format bundle between two instances,
and a mixed Newick + CSV bundle that renders both a tree and a metadata table.

## Acceptance status (v0.3)

| Criterion | Status |
| --- | --- |
| Two apps on different origins connect | ✅ e2e (loopback HTTP; see policy below) |
| A discovers B's capabilities without a server | ✅ e2e |
| Exact matching format identified automatically | ✅ e2e + unit |
| Incompatible format rejected before transfer | ✅ e2e |
| User can approve or reject | ✅ e2e |
| Valid Newick imports correctly | ✅ e2e (single and multi-file) |
| Multi-file bundle with per-file and per-format limits | ✅ e2e + unit |
| Mixed Newick + CSV bundle in one transfer | ✅ e2e + unit |
| Per-file JSON metadata survives the transfer and re-export | ✅ unit + e2e |
| Unexpected origins rejected | ✅ unit (source check, exact `allowedOrigins`, origin cross-check) |
| Invalid schemas, excess sizes, expired sessions fail safely | ✅ unit + e2e (size) |
| Blocked windows / incompatible opener policies produce clear errors | ✅ codes implemented; not e2e (Playwright cannot block `window.open`, and COOP needs a separate deployment) |
| Chrome, Firefox, Safari | ✅ Chromium, Firefox, WebKit e2e |

Transport policy: HTTPS everywhere except `localhost`, `127.0.0.1`, and `[::1]`,
so development and tests need no certificates. This is a deliberate, documented
exception to "HTTPS only".

## Security in one paragraph

The receiver never releases data on discovery alone. Before approval it sees the
bundle name, total size, every file with its format and size, and the sender's
**verified** origin (not a claim). Origins are authenticated from
`MessageEvent.origin`, bound to `window.opener`, and pinned as the only allowed
origin; the invitation nonce is single-use and stripped from the URL. Every
inbound structure is validated, every file's format and schema is matched, and
file sets, sizes, and per-file JSON metadata are checked twice. Binary exports
are copied so the sender's memory is never detached. There is no sender identity, no payload signature, and
no confidentiality from the receiver's own origin. Read
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

## Out of scope for v0.3

WebRTC, format conversion, per-file approval within one bundle, unattended
transfers, chunking/streaming, persistent sessions, SDKs for other languages,
cloud storage, a global application directory, and sender authenticity.

## License

MIT
