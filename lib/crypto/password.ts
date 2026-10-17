import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { randomBytesOf, toBase64Url } from "./random";

/**
 * Password hashing with scrypt (node:crypto).
 *
 * scrypt is used (rather than Argon2id) because `node:crypto` scrypt is
 * available on Cloudflare Workers with `nodejs_compat`, whereas Argon2id needs
 * a native addon that cannot run on Workers.
 *
 * Encoded form:
 *   scrypt$N$r$p$<salt-b64url>$<hash-b64url>
 *
 * The parameters are stored alongside the hash so that future cost increases
 * are possible without invalidating existing credentials.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  /** CPU/memory cost, must be a power of two > 1. Default 2^15. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * Default parameters. N = 2^15 with r = 8 needs ~32 MiB, which fits inside the
 * Workers 128 MiB memory limit while remaining expensive enough to brute force
 * offline. Raise `N` to 2^16 on self-hosted Node.js deployments.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const KEY_LEN = 64;
const SALT_LEN = 16;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

export class PasswordPolicyError extends Error {
  override readonly name = "PasswordPolicyError";
}

/**
 * Reject passwords that violate the instance policy *before* hashing.
 *
 * Notably we never silently truncate: a longer-than-max password is an error,
 * not a shorter password. Silent truncation would let a user believe they have
 * a stronger secret than the one actually verified.
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string") {
    throw new PasswordPolicyError("Password must be a string.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
    );
  }
  // Reject strings that are entirely made of one repeated character and other
  // trivially guessable shapes without imposing a composition rule that pushes
  // users toward predictable substitutions.
  const lowered = password.toLowerCase();
  if (/^(.)\1+$/.test(lowered)) {
    throw new PasswordPolicyError("Password must not be a single repeated character.");
  }
  // A dictionary word is weak on its own and stays weak with digits bolted on
  // ("password", "password123", "changeme123456").
  for (const base of WEAK_PASSWORD_BASES) {
    if (lowered === base) {
      throw new PasswordPolicyError("Password is on the rejected-password list.");
    }
    if (lowered.startsWith(base)) {
      const remainder = lowered.slice(base.length);
      if (remainder.length > 0 && /^\d+$/.test(remainder)) {
        throw new PasswordPolicyError("Password is a dictionary word followed by digits.");
      }
    }
  }
  // Keyboard walks and repeated pairs.
  if (/^(123456789|qwertyuiop|asdfghjkl)/.test(lowered)) {
    throw new PasswordPolicyError("Password is a keyboard sequence.");
  }
}

const WEAK_PASSWORD_BASES: readonly string[] = [
  "password",
  "passw0rd",
  "changeme",
  "letmein",
  "iloveyou",
  "administrator",
  "henna",
  "welcome",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "master",
  "superman",
];

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytesOf(SALT_LEN);
  const derived = await derive(password, salt, params);
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    toBase64Url(salt),
    toBase64Url(derived),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) {
    return false;
  }
  const parsed = parseEncoded(encoded);
  if (parsed === null) {
    return false;
  }
  const derived = await derive(password, parsed.salt, parsed.params);
  if (derived.length !== parsed.hash.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}

/** True when the stored hash used parameters weaker than the current default. */
export function needsRehash(encoded: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parsed = parseEncoded(encoded);
  if (parsed === null) return true;
  return parsed.params.N < params.N || parsed.params.r < params.r || parsed.params.p < params.p;
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  // scrypt's memory requirement is 128 * N * r; add headroom for the
  // implementation's own buffers.
  const maxmem = 128 * params.N * params.r * 2 + 1024 * 1024;
  return scryptAsync(password, salt, KEY_LEN, { ...params, maxmem });
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parseEncoded(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  const [scheme, nPart, rPart, pPart, saltPart, hashPart] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== "scrypt") return null;
  const N = Number.parseInt(nPart, 10);
  const r = Number.parseInt(rPart, 10);
  const p = Number.parseInt(pPart, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 16384 || r < 1 || p < 1) return null;
  const salt = Buffer.from(saltPart, "base64url");
  const hash = Buffer.from(hashPart, "base64url");
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N, r, p }, salt, hash };
}

export const PASSWORD_LIMITS = {
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
} as const;
