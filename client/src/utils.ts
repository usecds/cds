import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();

// Text is hashed as its UTF-8 bytes, the bytes the store serves
const bytesOf = (content: string | Uint8Array): Uint8Array => (typeof content === "string" ? encoder.encode(content) : content);

/**
 * SHA-256 (hex) with Web Crypto, in Node, browsers and edge runtimes. Without `crypto.subtle`
 * (a page served over plain http, which isn't a secure context) it falls back to sha256Sync.
 */
export async function sha256(content: string | Uint8Array): Promise<string> {
  const bytes = bytesOf(content);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Sync(bytes);
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource)));
}

/** SHA-256 (hex) in plain JavaScript, synchronous: the fallback, and for short texts in sync APIs */
export function sha256Sync(content: string | Uint8Array): string {
  return bytesToHex(nobleSha256(bytesOf(content)));
}
