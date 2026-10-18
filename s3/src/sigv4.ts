import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// AWS Signature Version 4 for a request without a body, in plain JavaScript: synchronous and
// independent of crypto.subtle, so it also signs on pages that aren't a secure context (a kiosk
// served over http on a LAN address)

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hex = (data: string) => bytesToHex(sha256(encoder.encode(data)));
const mac = (key: Uint8Array | string, data: string) => hmac(sha256, typeof key === "string" ? encoder.encode(key) : key, encoder.encode(data));

// RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone)
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: string;
  /** Headers to sign besides host and the x-amz-* ones this adds (e.g. range) */
  headers?: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  /** The request time as YYYYMMDDTHHMMSSZ (default: now) */
  datetime?: string;
}

/** The headers to add to the request: authorization, x-amz-date, x-amz-content-sha256 (and the session token) */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const datetime = input.datetime ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = datetime.slice(0, 8);

  const added: Record<string, string> = {
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": datetime,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {})
  };
  const signed = new Map<string, string>([["host", url.host]]);
  for (const [name, value] of Object.entries({ ...input.headers, ...added })) signed.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  const names = [...signed.keys()].sort();

  const path = url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/");
  const query = [...url.searchParams].map(([k, v]) => `${encode(k)}=${encode(v)}`).sort().join("&");
  const canonical = [
    input.method.toUpperCase(),
    path,
    query,
    names.map((n) => `${n}:${signed.get(n)}\n`).join(""),
    names.join(";"),
    EMPTY_SHA256
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, hex(canonical)].join("\n");
  const key = mac(mac(mac(mac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), "aws4_request");
  const signature = bytesToHex(mac(key, stringToSign));

  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`
  };
}
