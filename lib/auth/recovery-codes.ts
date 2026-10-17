import { keyedDigest, safeEqual } from "@/lib/crypto/constant-time";
import { getKeyring } from "@/lib/crypto/keyring";
import { generateRecoveryCodes } from "@/lib/crypto/random";

/**
 * One-time recovery codes.
 *
 * Recovery codes are the escape hatch when an authenticator is lost, which
 * makes them as sensitive as a TOTP secret: only a keyed digest is stored, they
 * are shown exactly once at generation time, and each one works once.
 */

export const RECOVERY_CODE_COUNT = 10;

export interface GeneratedRecoveryCodes {
  /** Plaintext, shown once. Never persisted. */
  readonly plaintext: readonly string[];
  /** Keyed digests, in the same order as `plaintext`. */
  readonly hashes: readonly string[];
}

export function generateRecoveryCodeSet(count = RECOVERY_CODE_COUNT): GeneratedRecoveryCodes {
  const plaintext = generateRecoveryCodes(count);
  return { plaintext, hashes: plaintext.map((code) => hashRecoveryCode(code)) };
}

export function hashRecoveryCode(code: string): string {
  return keyedDigest(normalise(code), Buffer.from(getKeyring().activeKeyId, "utf8"));
}

/**
 * Normalise user input: recovery codes are case-insensitive, and a code may be
 * pasted with or without the dashes.
 */
export function normalise(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^(.{4})(.{4})(.{4})$/, "$1-$2-$3");
}

/** Presentation form, e.g. `k4f9-2b7d-8c1e`. */
export function formatRecoveryCode(code: string): string {
  const raw = code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (raw.length !== 12) return code;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export interface StoredRecoveryCode {
  readonly id: string;
  readonly codeHash: string;
  readonly usedAt: Date | null;
}

export type RecoveryCodeCheck =
  | { readonly ok: true; readonly matchedId: string }
  | { readonly ok: false; readonly reason: "no-match" | "already-used" };

/**
 * Find an unused code matching the supplied value.
 *
 * All stored digests are compared (not short-circuited on the first match) so
 * that the time taken does not reveal which slot matched.
 */
export function matchRecoveryCode(
  supplied: string,
  stored: readonly StoredRecoveryCode[],
): RecoveryCodeCheck {
  const candidate = hashRecoveryCode(supplied);
  let matched: StoredRecoveryCode | null = null;
  let used: StoredRecoveryCode | null = null;

  for (const entry of stored) {
    const equal = safeEqual(entry.codeHash, candidate);
    if (!equal) continue;
    if (entry.usedAt !== null) {
      used = entry;
    } else {
      matched = entry;
    }
  }

  if (matched) return { ok: true, matchedId: matched.id };
  if (used) return { ok: false, reason: "already-used" };
  return { ok: false, reason: "no-match" };
}

/** How many codes remain — drives the "regenerate now" prompt. */
export function remainingCount(stored: readonly StoredRecoveryCode[]): number {
  return stored.filter((entry) => entry.usedAt === null).length;
}

/**
 * Whether the user should be pushed to regenerate. Henna prompts after any use,
 * and nags once half the set is gone.
 */
export function shouldPromptRegeneration(stored: readonly StoredRecoveryCode[]): boolean {
  const remaining = remainingCount(stored);
  return remaining === 0 || remaining <= Math.floor(stored.length / 2);
}
