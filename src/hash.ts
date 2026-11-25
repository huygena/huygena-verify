/**
 * SHA-256 through Web Crypto (`globalThis.crypto.subtle`), so this module runs
 * unchanged in Node 20+, browsers, Deno, Bun and Cloudflare Workers.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto (crypto.subtle) is not available in this runtime");
  return c.subtle;
}

/** SHA-256 of bytes or of a string's UTF-8 encoding, as 64 lowercase hex characters. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  // Copy into a fresh ArrayBuffer: Web Crypto rejects SharedArrayBuffer views in some runtimes.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const digest = await subtle().digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

const HEX64 = /^[0-9a-f]{64}$/;

/** True for `sha256:` followed by 64 lowercase hex characters. */
export function isSha256Ref(value: string): boolean {
  return value.startsWith("sha256:") && HEX64.test(value.slice(7));
}

/**
 * Normalize a hash someone pasted: trims, lowercases, accepts it with or
 * without the `sha256:` prefix. Returns `sha256:<hex>` or `null` when it is not a SHA-256.
 */
export function normalizeSha256(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/^sha256:/, "");
  return HEX64.test(v) ? `sha256:${v}` : null;
}
