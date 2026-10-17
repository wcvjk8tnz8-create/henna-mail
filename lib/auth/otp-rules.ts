/**
 * Pure rules for email verification codes.
 *
 * Split out from `lib/auth/email-otp.ts` (which talks to PostgreSQL) so that
 * the lifetime, cooldown and attempt-count rules can be unit tested without a
 * database, and reused by the password-reset flow.
 */

export interface OtpCodeState {
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export function isExpired(state: Pick<OtpCodeState, "expiresAt">, now = Date.now()): boolean {
  return state.expiresAt.getTime() <= now;
}

export function isConsumed(state: Pick<OtpCodeState, "consumedAt">): boolean {
  return state.consumedAt !== null;
}

export function attemptsExhausted(
  state: Pick<OtpCodeState, "attempts" | "maxAttempts">,
): boolean {
  return state.attempts >= state.maxAttempts;
}

export function attemptsRemaining(
  state: Pick<OtpCodeState, "attempts" | "maxAttempts">,
): number {
  return Math.max(0, state.maxAttempts - state.attempts);
}

/** True while a freshly issued code would be too soon after the previous one. */
export function isWithinCooldown(
  createdAt: Date,
  cooldownSeconds: number,
  now = Date.now(),
): boolean {
  return now - createdAt.getTime() < cooldownSeconds * 1000;
}

export function cooldownRemainingSeconds(
  createdAt: Date,
  cooldownSeconds: number,
  now = Date.now(),
): number {
  const elapsed = Math.floor((now - createdAt.getTime()) / 1000);
  return Math.max(0, cooldownSeconds - elapsed);
}

export type OtpVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "expired" | "used" | "too-many-attempts" };

/**
 * The pre-comparison gate: anything that disqualifies a code is checked before
 * the presented value is even hashed, so an attacker learns nothing about the
 * code from the reason for refusal.
 */
export function evaluateOtpState(state: OtpCodeState, now = Date.now()): OtpVerdict {
  if (isConsumed(state)) return { ok: false, reason: "used" };
  if (isExpired(state, now)) return { ok: false, reason: "expired" };
  if (attemptsExhausted(state)) return { ok: false, reason: "too-many-attempts" };
  return { ok: true };
}

/** Default lifetime: 10 minutes, as required. */
export const DEFAULT_OTP_TTL_SECONDS = 600;
export const DEFAULT_OTP_MAX_ATTEMPTS = 5;
export const DEFAULT_OTP_COOLDOWN_SECONDS = 60;
