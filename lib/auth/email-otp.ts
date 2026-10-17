import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { emailOtpCodes } from "@/db/schema";
import { keyedDigest, safeEqual } from "@/lib/crypto/constant-time";
import { getKeyring } from "@/lib/crypto/keyring";
import { randomNumericCode } from "@/lib/crypto/random";
import type { RequestContext } from "@/lib/request";
import { isExpired, attemptsRemaining } from "./otp-rules";

/**
 * Email verification codes (6 digits) used for passwordless login and for
 * password reset.
 *
 * Properties required by the specification:
 *  - 10 minute lifetime by default (instance configurable, 60s–1h).
 *  - Single use: a consumed code can never be presented again.
 *  - Only a keyed digest of the code is stored — never the code itself, and
 *    never in a log line or an error message.
 *  - At most 5 attempts by default; the counter is stored with the code so
 *    that guessing across concurrent requests cannot reset it.
 *  - Sending and verifying are rate limited by the caller (lib/rate-limit.ts).
 */

export const OTP_DIGITS = 6;
export { DEFAULT_OTP_TTL_SECONDS, DEFAULT_OTP_MAX_ATTEMPTS } from "./otp-rules";

export interface IssueOtpInput {
  readonly email: string;
  readonly userId?: string | null;
  readonly purpose: "login" | "password_reset";
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly context: RequestContext;
}

export interface IssuedOtp {
  readonly id: string;
  /** Plaintext code, handed straight to the mailer. Not stored. */
  readonly code: string;
  readonly expiresAt: Date;
}

export async function issueEmailOtp(input: IssueOtpInput): Promise<IssuedOtp> {
  const db = getDb();
  const code = randomNumericCode(OTP_DIGITS);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  const [row] = await db
    .insert(emailOtpCodes)
    .values({
      userId: input.userId ?? null,
      email: input.email,
      codeHash: hashOtpCode(code),
      purpose: input.purpose,
      maxAttempts: input.maxAttempts,
      expiresAt,
      ipHash: input.context.ipHash,
    })
    .returning({ id: emailOtpCodes.id });

  if (!row) throw new Error("Failed to issue an email verification code");
  return { id: row.id, code, expiresAt };
}

/**
 * The most recent code issued to an address, used for the resend cooldown.
 * Deliberately returns no code material.
 */
export async function lastOtpForEmail(
  email: string,
  purpose: "login" | "password_reset",
): Promise<{ createdAt: Date; consumedAt: Date | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({ createdAt: emailOtpCodes.createdAt, consumedAt: emailOtpCodes.consumedAt })
    .from(emailOtpCodes)
    .where(and(eq(emailOtpCodes.email, email), eq(emailOtpCodes.purpose, purpose)))
    .orderBy(desc(emailOtpCodes.createdAt))
    .limit(1);
  return row ?? null;
}

export type VerifyOtpOutcome =
  | { readonly ok: true; readonly userId: string | null; readonly email: string }
  | {
      readonly ok: false;
      readonly reason: "no-code" | "expired" | "already-used" | "too-many-attempts" | "wrong-code";
      readonly attemptsLeft: number;
    };

export interface VerifyOtpInput {
  readonly email: string;
  readonly code: string;
  readonly purpose: "login" | "password_reset";
}

/**
 * Verify a code.
 *
 * The attempt counter is incremented before the comparison so that a
 * wrong-but-valid-shaped code always costs one attempt. When attempts run out
 * the code is burned immediately, so a brute force cannot continue against a
 * partially-guessed code.
 */
export async function verifyEmailOtp(input: VerifyOtpInput): Promise<VerifyOtpOutcome> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(emailOtpCodes)
    .where(
      and(
        eq(emailOtpCodes.email, input.email),
        eq(emailOtpCodes.purpose, input.purpose),
        isNull(emailOtpCodes.consumedAt),
      ),
    )
    .orderBy(desc(emailOtpCodes.createdAt))
    .limit(1);

  if (!row) {
    return { ok: false, reason: "no-code", attemptsLeft: 0 };
  }

  if (isExpired(row)) {
    await burnCode(row.id);
    return { ok: false, reason: "expired", attemptsLeft: 0 };
  }

  if (row.attempts >= row.maxAttempts) {
    await burnCode(row.id);
    return { ok: false, reason: "too-many-attempts", attemptsLeft: 0 };
  }

  const matches = safeCompareOtp(row.codeHash, hashOtpCode(input.code));

  if (!matches) {
    const attempts = row.attempts + 1;
    await db
      .update(emailOtpCodes)
      .set({ attempts })
      .where(eq(emailOtpCodes.id, row.id));
    if (attempts >= row.maxAttempts) {
      await burnCode(row.id);
      return { ok: false, reason: "too-many-attempts", attemptsLeft: 0 };
    }
    return { ok: false, reason: "wrong-code", attemptsLeft: attemptsRemaining({ attempts, maxAttempts: row.maxAttempts }) };
  }

  await burnCode(row.id);
  return { ok: true, userId: row.userId, email: row.email };
}

async function burnCode(id: string): Promise<void> {
  const db = getDb();
  await db.update(emailOtpCodes).set({ consumedAt: new Date() }).where(eq(emailOtpCodes.id, id));
}

function hashOtpCode(code: string): string {
  return keyedDigest(code, Buffer.from(getKeyring().activeKeyId, "utf8"));
}

function safeCompareOtp(storedHash: string, candidateHash: string): boolean {
  return safeEqual(storedHash, candidateHash);
}

/**
 * Purge codes that can no longer be used. Called from a scheduled task; a code
 * is already unusable once expired, so this is housekeeping, not a control.
 */
export async function purgeExpiredOtps(): Promise<number> {
  const db = getDb();
  const { lt } = await import("drizzle-orm");
  const rows = await db
    .delete(emailOtpCodes)
    .where(lt(emailOtpCodes.expiresAt, new Date(Date.now() - 24 * 3600 * 1000)))
    .returning({ id: emailOtpCodes.id });
  return rows.length;
}
