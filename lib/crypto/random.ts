import { randomBytes, randomInt, randomUUID } from "node:crypto";

/**
 * Cryptographically secure randomness helpers.
 *
 * All randomness in Henna flows through this module so that there is exactly
 * one place to audit for CSPRNG usage. `Math.random()` is never used for
 * security relevant values.
 */

/** URL-safe base64 (no padding) encoding used across Henna. */
export function toBase64Url(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

export function fromBase64Url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** `n` cryptographically secure random bytes. */
export function randomBytesOf(n: number): Buffer {
  return randomBytes(n);
}

/** A 128-bit opaque identifier, base64url encoded. */
export function randomId(): string {
  return toBase64Url(randomBytes(16));
}

export function randomUuid(): string {
  return randomUUID();
}

/**
 * A uniformly distributed numeric code with exactly `digits` digits.
 * Uses rejection-free modular reduction over a wide random sample to avoid
 * modulo bias.
 */
export function randomNumericCode(digits: number): string {
  if (digits < 4 || digits > 10) {
    throw new RangeError("digits must be between 4 and 10");
  }
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, "0");
}

/**
 * Characters used for recovery codes.
 *
 * Deliberately `[a-z0-9]` only, with no `-` or `_`: those characters are the
 * separators and the recovery-code schema forbids them inside a group, so a
 * base64url sample would occasionally produce an unusable code.
 */
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A uniformly random character from `ALPHANUMERIC`, via rejection sampling so
 * that no character is more likely than another.
 */
function randomAlphanumeric(): string {
  const limit = 256 - (256 % ALPHANUMERIC.length);
  for (;;) {
    const byte = randomBytes(1)[0] ?? 0;
    if (byte < limit) return ALPHANUMERIC[byte % ALPHANUMERIC.length] ?? "a";
  }
}

/** Generate `count` human-readable recovery codes, e.g. `k4f9-2b7d-8c1e`. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const group = (): string =>
      `${randomAlphanumeric()}${randomAlphanumeric()}${randomAlphanumeric()}${randomAlphanumeric()}`;
    codes.push(`${group()}-${group()}-${group()}`);
  }
  return codes;
}
