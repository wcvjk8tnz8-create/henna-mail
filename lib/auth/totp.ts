import * as OTPAuth from "otpauth";
import { getKeyring } from "@/lib/crypto/keyring";
import { randomBytesOf } from "@/lib/crypto/random";
import { safeEqual } from "@/lib/crypto/constant-time";

/**
 * TOTP (RFC 6238) second factor.
 *
 * `otpauth` is a pure-TypeScript implementation with no Node.js built-ins, so
 * it runs unchanged on Cloudflare Workers — verified in tests/unit/totp.test.ts
 * which executes under the same module graph as the Worker bundle.
 *
 * Security properties enforced here:
 *  - The shared secret is AES-256-GCM encrypted before it is stored; the
 *    plaintext secret only ever exists for the duration of one verification.
 *  - The accepted window is ±1 step of 30 seconds. There is no "wide window"
 *    mode: a code from two minutes ago is rejected.
 *  - Replay protection: the counter of the last accepted step is stored, and
 *    any code at or before it is refused even though it is still inside the
 *    window. Codes are compared in constant time.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = "SHA1" as const;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, no padding.
 *
 * Written out rather than pulled from a dependency so the entropy source is
 * visible: `randomBytesOf` is the only randomness in this path.
 */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** ±1 step, as required. */
export const TOTP_WINDOW = 1;

export interface TotpEnrollment {
  /** Base32 secret. Shown to the user once, then only the ciphertext persists. */
  readonly secret: string;
  /** `otpauth://totp/...` provisioning URI for QR rendering. */
  readonly uri: string;
  /** AES-256-GCM `iv:authTag:ciphertext` — the only value we store. */
  readonly encryptedSecret: string;
  readonly keyId: string;
}

export function generateTotpSecret(issuer: string, accountName: string): TotpEnrollment {
  // 160 bits of entropy, matching RFC 4226's recommendation for HOTP secrets.
  // Generated straight as base32 so the value stored and the value shown to the
  // user are the same string — no encoding step to get wrong.
  const secret = OTPAuth.Secret.fromBase32(base32Encode(randomBytesOf(20)));
  const totp = new OTPAuth.TOTP({
    issuer,
    label: accountName,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
  const keyring = getKeyring();
  return {
    secret: secret.base32,
    uri: totp.toString(),
    encryptedSecret: keyring.encrypt(secret.base32, "totp_secret"),
    keyId: keyring.activeKeyId,
  };
}

export type TotpVerifyResult =
  | { readonly ok: true; readonly step: number; readonly drift: number }
  | { readonly ok: false; readonly reason: "invalid" | "expired" | "replay" | "tampered" };

/**
 * Verify a TOTP code.
 *
 * @param encryptedSecret ciphertext from `totp_secrets.secret_enc`
 * @param code the user-supplied 6-digit code
 * @param lastUsedStep the stored `last_used_step`, or null on first use
 */
export function verifyTotp(
  encryptedSecret: string,
  code: string,
  lastUsedStep: number | null = null,
): TotpVerifyResult {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

  let base32: string;
  try {
    base32 = getKeyring().decrypt(encryptedSecret, "totp_secret");
  } catch {
    // A payload that fails GCM authentication is either tampered with or
    // encrypted under a retired key; the caller audits this.
    return { ok: false, reason: "tampered" };
  }

  const totp = new OTPAuth.TOTP({
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(base32),
  });

  const now = Date.now();
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  const delta = totp.validate({ token: code, window: TOTP_WINDOW, timestamp: now });

  if (delta === null) return { ok: false, reason: "expired" };

  const usedStep = currentStep + delta;

  // Replay guard. `lastUsedStep` is the newest step already consumed; because
  // `window` is ±1, an attacker replaying within the same step (or the one just
  // before it) is refused.
  if (lastUsedStep !== null && usedStep <= lastUsedStep) {
    return { ok: false, reason: "replay" };
  }

  return { ok: true, step: usedStep, drift: delta };
}

/**
 * Constant-time code comparison used where the caller already holds the
 * expected value (for example the enrolment confirmation flow).
 */
export function constantTimeCodeEquals(a: string, b: string): boolean {
  return safeEqual(a, b);
}

/** Current TOTP step, exposed for tests and for the "wait for next code" hint. */
export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

/** Seconds until the current step rolls over. */
export function secondsUntilNextStep(now = Date.now()): number {
  const elapsed = Math.floor(now / 1000) % TOTP_PERIOD_SECONDS;
  return TOTP_PERIOD_SECONDS - elapsed;
}
