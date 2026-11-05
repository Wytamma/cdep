/**
 * Payload size and normalization helpers.
 *
 * `TextEncoder` would allocate a full copy just to learn a size, and payloads
 * arrive from an untrusted peer, so UTF-8 length is computed in one pass.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function payloadByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
}

/**
 * Produces a transferable copy of a binary export.
 *
 * `postMessage` transfer detaches the transferred buffer. Transferring the
 * application's own buffer (a WASM memory view, a cached response) would
 * silently corrupt the sender, so the SDK copies once and transfers the copy.
 */
export function toTransferableBuffer(data: string | ArrayBuffer | Uint8Array): {
  data: string | ArrayBuffer;
  buffer?: ArrayBuffer;
} {
  if (typeof data === "string") return { data };
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return { data: copy.buffer, buffer: copy.buffer };
}
