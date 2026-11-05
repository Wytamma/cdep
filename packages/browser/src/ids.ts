/** Session identifiers are 128-bit random values, hex encoded. */
const SID_PATTERN = /^[a-f0-9]{32}$/;

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SID_PATTERN.test(value);
}
