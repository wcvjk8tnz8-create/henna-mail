/**
 * AWS Signature Version 4 primitives, built on WebCrypto.
 *
 * Why this exists instead of `@aws-sdk/s3-request-presigner`: the AWS SDK pulls
 * a dependency tree that is heavy on Node.js built-ins and awkward on Cloudflare
 * Workers, and it is far more than Henna needs. SigV4 for query-string
 * presigning is about 120 lines of HMAC and hex, and those two primitives are
 * available everywhere Henna runs — `node:crypto`'s webcrypto in Node 20+, and
 * the native `crypto` global on Workers.
 *
 * Everything here is pure and synchronous in its inputs, so it is unit-testable
 * without a network, a bucket, or a clock.
 */

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
const HEX = "0123456789abcdef";

/** RFC 3986 encoding of a single component: everything except unreserved. */
export function uriEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (UNRESERVED.includes(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Encode a path, preserving `/`.
 *
 * Encoding per segment rather than over the whole string is what keeps a key
 * like `a/b c` from collapsing into `a%2Fb%20c`.
 */
export function uriEncodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

/** Query string in canonical form: keys sorted, both halves encoded. */
export function canonicalQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return [...params]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 15];
  }
  return out;
}

/** Copy into a standalone ArrayBuffer: `subtle` rejects a shared or sliced view. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto || typeof webcrypto.subtle === "undefined") {
    throw new Error("WebCrypto is unavailable in this runtime");
  }
  return webcrypto.subtle;
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(data));
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle().sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

/**
 * The four-step signing key:
 *   kSecret → kDate → kRegion → kService → kSigning
 */
export async function deriveSigningKey(input: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): Promise<Uint8Array> {
  const kSecret = new TextEncoder().encode(`AWS4${input.secretAccessKey}`);
  const kDate = await hmacSha256(kSecret, input.dateStamp);
  const kRegion = await hmacSha256(kDate, input.region);
  const kService = await hmacSha256(kRegion, input.service);
  return hmacSha256(kService, "aws4_request");
}

/** `20260101T121500Z` — the format SigV4 expects in the credential scope. */
export function formatAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/** `20260101` — the date stamp used to derive the signing key. */
export function formatDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
