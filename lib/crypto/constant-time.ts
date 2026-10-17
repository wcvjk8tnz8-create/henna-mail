import { createHmac, timingSafeEqual } from "node:crypto";
import { toBase64Url } from "./random";

/**
 * Constant-time primitives.
 *
 * Every secret comparison in Henna (CSRF tokens, TOTP codes, OTP codes,
 * recovery codes, OAuth `state`) goes through `safeEqual` so that response
 * timing cannot be used as an oracle.
 */

/** Constant-time comparison of two strings of potentially different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Length is not secret for fixed-width secrets, but for variable-length
  // inputs (e.g. user-chosen codes) we compare a digest of both so that the
  // comparison time does not leak the length.
  if (bufA.length !== bufB.length) {
    const hashA = createHmac("sha256", "henna-length-equaliser").update(bufA).digest();
    const hashB = createHmac("sha256", "henna-length-equaliser").update(bufB).digest();
    return timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Constant-time comparison of two buffers. */
export function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    const hashA = createHmac("sha256", "henna-length-equaliser").update(a).digest();
    const hashB = createHmac("sha256", "henna-length-equaliser").update(b).digest();
    return timingSafeEqual(hashA, hashB) && a.length === b.length;
  }
  return timingSafeEqual(a, b);
}

/**
 * Keyed, deterministic one-way digest used for storing single-use secrets
 * (email OTP codes, recovery codes, refresh tokens).
 *
 * A server-side pepper (`HENNA_CREDENTIAL_KEY`'s active key) is mixed in so
 * that a database-only dump cannot be brute-forced offline.
 */
export function keyedDigest(value: string, pepper: Buffer): string {
  return toBase64Url(createHmac("sha256", pepper).update(value, "utf8").digest());
}
