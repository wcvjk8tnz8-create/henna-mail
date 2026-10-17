import {
  canonicalQuery,
  deriveSigningKey,
  formatAmzDate,
  formatDateStamp,
  hmacSha256,
  sha256Hex,
  toHex,
  uriEncode,
  uriEncodePath,
} from "./sigv4";

/**
 * Query-string presigning for S3-compatible object storage.
 *
 * The whole point of this module is that **Henna's server never handles the
 * bytes**. It hands the browser a signed URL and the browser talks to R2 (or
 * S3, or MinIO) directly. The server sees a filename and a size; it never sees
 * an attachment.
 *
 * Presigned URLs are signed with payload hash `UNSIGNED-PAYLOAD`, because the
 * server cannot know the body in advance. Any header placed in
 * `SignedHeaders` must therefore be sent by the client verbatim — hence the
 * `requiredHeaders` field in the result, which callers must pass back to the
 * browser and the browser must set.
 */

export type PresignMethod = "GET" | "PUT" | "HEAD" | "DELETE";

export interface PresignInput {
  readonly method: PresignMethod;
  /** Origin only, with no path or trailing slash: `https://…cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly key: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresInSeconds: number;
  /** Path-style (`/bucket/key`) is what R2 uses; virtual-host is the S3 default. */
  readonly forcePathStyle?: boolean;
  /** Signed when present, so the stored content type cannot be swapped. */
  readonly contentType?: string;
  /** Injectable for tests; defaults to now. */
  readonly now?: Date;
}

export interface PresignedRequest {
  readonly url: string;
  readonly method: PresignMethod;
  /** Headers the client must send verbatim, or the signature will not match. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  readonly key: string;
}

/**
 * A content type that is safe to place in a signed header.
 *
 * The value ends up inside `SignedHeaders`, so a newline or a stray colon would
 * be header injection into the canonical request. Validated strictly against a
 * narrow grammar rather than escaped.
 */
export function isSafeContentType(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(;\s?[a-zA-Z0-9-]+="?[a-zA-Z0-9._=/-]*"?)?$/.test(
    value,
  );
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** SigV4 caps a presigned URL at 7 days; Henna keeps it far shorter anyway. */
export const MAX_PRESIGN_TTL_SECONDS = 604800;

export function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 300;
  return Math.min(Math.round(seconds), MAX_PRESIGN_TTL_SECONDS);
}

/** Split an origin into scheme and host, rejecting anything with a path. */
function splitEndpoint(endpoint: string): { scheme: string; host: string } {
  const url = new URL(endpoint);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Storage endpoint must be an origin, with no path");
  }
  return { scheme: url.protocol.replace(":", ""), host: url.host };
}

export async function presign(input: PresignInput): Promise<PresignedRequest> {
  const now = input.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = formatDateStamp(now);
  const expires = String(clampTtl(input.expiresInSeconds));
  const { scheme, host } = splitEndpoint(input.endpoint);

  const forcePathStyle = input.forcePathStyle ?? true;
  const encodedKey = uriEncodePath(input.key);

  // Virtual-host style puts the bucket in the hostname, so it belongs in the
  // signed `host` header; path style keeps it in the URI.
  const requestHost = forcePathStyle ? host : `${input.bucket}.${host}`;
  const canonicalUri = uriEncodePath(forcePathStyle ? `/${input.bucket}/${input.key}` : `/${input.key}`);
  const baseUrl = forcePathStyle
    ? `${scheme}://${host}/${input.bucket}/${encodedKey}`
    : `${scheme}://${requestHost}/${encodedKey}`;

  // Headers are sorted by name in canonical form, as SigV4 requires.
  const headers: Array<readonly [string, string]> = [["host", requestHost]];
  const requiredHeaders: Record<string, string> = {};

  if (input.contentType) {
    headers.push(["content-type", input.contentType]);
    requiredHeaders["content-type"] = input.contentType;
  }

  // Writes need the payload hash declared, because the body is not signed.
  if (input.method === "PUT") {
    headers.push(["x-amz-content-sha256", UNSIGNED_PAYLOAD]);
    requiredHeaders["x-amz-content-sha256"] = UNSIGNED_PAYLOAD;
  }

  headers.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value.trim()}\n`).join("");

  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const credential = `${input.accessKeyId}/${credentialScope}`;

  const query = canonicalQuery([
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", expires],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);

  const canonicalRequest = [
    input.method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey({
    secretAccessKey: input.secretAccessKey,
    dateStamp,
    region: input.region,
    service: SERVICE,
  });

  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return {
    url: `${baseUrl}?${query}&${uriEncode("X-Amz-Signature")}=${signature}`,
    method: input.method,
    requiredHeaders,
    expiresAt: new Date(now.getTime() + Number(expires) * 1000).toISOString(),
    key: input.key,
  };
}
