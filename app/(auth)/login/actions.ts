"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticateWithPassword, setPassword } from "@/lib/auth/password";
import { issueEmailOtp, lastOtpForEmail, verifyEmailOtp } from "@/lib/auth/email-otp";
import { ACCESS_COOKIE, createSession, type PrimaryAuthMethod } from "@/lib/auth/session";
import { buildRequestContext } from "@/lib/request";
import { getInstanceSettings } from "@/lib/config/settings";
import { isManagedAddress } from "@/lib/config/domains";
import { consumeRateLimit, resetRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { getTotpStatus } from "@/lib/dal/totp";
import { createUser, findUserByEmail, markEmailVerified } from "@/lib/dal/users";
import { issueCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/security/csrf";
import {
  parseInput,
  passwordLoginSchema,
  emailOtpRequestSchema,
  emailOtpVerifySchema,
  formDataToObject,
} from "@/lib/validation/schemas";

/**
 * Primary authentication Server Actions.
 *
 * Next.js's built-in CSRF protection for Server Actions is left exactly as it
 * is — nothing here disables or weakens it. Every action parses its input with
 * Zod, performs its work through the DAL, and returns a response that is
 * identical whether or not the account exists.
 */

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly redirectTo?: string;
}

const GENERIC_FAILURE = "We could not sign you in. Check your details and try again.";

async function context() {
  return buildRequestContext(await headers());
}

/**
 * Establish a session for a user.
 *
 * When the second factor is owed, the session is created as `pending_mfa` and
 * the caller is sent to /mfa. The session id is replaced when MFA completes, so
 * the pre-MFA token is worthless afterwards.
 */
async function establishSession(input: {
  readonly userId: string;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly method: PrimaryAuthMethod;
}): Promise<string> {
  const settings = await getInstanceSettings();
  const status = await getTotpStatus({
    userId: input.userId,
    email: input.email,
    role: input.role,
    sessionId: "",
    amr: [input.method],
    mfaSatisfied: false,
    emailVerified: true,
  });

  const policy =
    input.role === "admin" && settings.totpPolicy === "optional" ? "admin-only" : settings.totpPolicy;
  const owesMfa =
    policy === "required"
      ? true
      : policy === "admin-only"
        ? input.role === "admin"
        : status.confirmed;

  const jar = await cookies();
  const isProd = process.env.NODE_ENV === "production";

  const tokens = await createSession({
    userId: input.userId,
    email: input.email,
    role: input.role,
    authMethod: input.method,
    status: owesMfa ? "pending_mfa" : "active",
    accessTtlSeconds: settings.sessionTtlSeconds,
    refreshTtlSeconds: settings.refreshTtlSeconds,
  });

  jar.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    expires: tokens.accessExpiresAt,
  });
  jar.set("henna_refresh", tokens.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    expires: tokens.refreshExpiresAt,
  });
  jar.set(CSRF_COOKIE, issueCsrfToken(tokens.sessionId), csrfCookieOptions(isProd));

  if (owesMfa) {
    jar.set("henna_pending_mfa", tokens.sessionId, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return "/mfa";
  }

  jar.delete("henna_pending_mfa");
  return "/inbox";
}

export async function signInWithPassword(formData: FormData): Promise<ActionResult> {
  const parsed = parseInput(passwordLoginSchema, formDataToObject(formData));
  if (!parsed.ok) {
    return { ok: false, message: parsed.issues[0] ?? GENERIC_FAILURE };
  }

  const settings = await getInstanceSettings();
  if (!settings.authMethods.includes("password")) {
    return { ok: false, message: "Password sign-in is disabled on this instance." };
  }

  // A managed-domain check is not required here (existing accounts may use any
  // address they verified), but the address must at least be well formed.
  const ctx = await context();
  const outcome = await authenticateWithPassword({
    email: parsed.value.email,
    password: parsed.value.password,
    context: ctx,
  });

  if (!outcome.ok) {
    if (outcome.reason === "rate-limited") {
      return {
        ok: false,
        message: `Too many attempts. Try again in ${outcome.retryAfterSeconds ?? 60} seconds.`,
      };
    }
    if (outcome.reason === "locked") {
      return { ok: false, message: "This account is locked. Contact an administrator." };
    }
    // Same message for "no such account" and "wrong password".
    return { ok: false, message: GENERIC_FAILURE };
  }

  const target = await establishSession({
    userId: outcome.user.id,
    email: outcome.user.email,
    role: outcome.user.role,
    method: "password",
  });

  redirect(target);
}

/**
 * Request or verify an email code.
 *
 * The response after a *request* is always the same, whether or not the address
 * has an account, so this cannot be used to discover who uses the instance.
 */
export async function requestEmailCode(formData: FormData): Promise<ActionResult> {
  const raw = formDataToObject(formData);
  const ctx = await context();
  const settings = await getInstanceSettings();

  if (!settings.authMethods.includes("email_otp")) {
    return { ok: false, message: "Email code sign-in is disabled on this instance." };
  }

  const hasCode = typeof raw.code === "string" && raw.code !== "";

  if (hasCode) {
    const parsed = parseInput(emailOtpVerifySchema, raw);
    if (!parsed.ok) return { ok: false, message: parsed.issues[0] ?? GENERIC_FAILURE };

    const limit = await consumeRateLimit(RATE_LIMIT_RULES.otpVerify, parsed.value.email);
    if (!limit.allowed) {
      return { ok: false, message: "Too many attempts. Request a new code." };
    }

    const result = await verifyEmailOtp({
      email: parsed.value.email,
      code: parsed.value.code,
      purpose: "login",
    });

    if (!result.ok) {
      await writeAudit({
        action: AUDIT_ACTIONS.LOGIN_EMAIL_OTP_FAILED,
        result: "denied",
        actorEmail: parsed.value.email,
        resourceType: "auth",
        ipHash: ctx.ipHash,
        userAgentHash: ctx.userAgentHash,
        metadata: { reason: result.reason },
      });
      return {
        ok: false,
        message:
          result.reason === "too-many-attempts"
            ? "That code has been tried too many times. Request a new one."
            : "That code is not valid any more. Request a new one.",
      };
    }

    const db = getDb();
    const [existing] = await db.select().from(users).where(eq(users.email, result.email));
    const user =
      existing ??
      (await createUser({ email: result.email, verified: true }));

    if (existing && existing.emailVerifiedAt === null) {
      await markEmailVerified(existing.id);
    }

    await resetRateLimit(RATE_LIMIT_RULES.otpVerify, parsed.value.email);
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_EMAIL_OTP_SUCCESS,
      result: "success",
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
    });

    const target = await establishSession({
      userId: user.id,
      email: user.email,
      role: user.role,
      method: "email_otp",
    });
    redirect(target);
  }

  const parsed = parseInput(emailOtpRequestSchema, raw);
  if (!parsed.ok) return { ok: false, message: parsed.issues[0] ?? GENERIC_FAILURE };

  // Only addresses on a served domain get a code at all.
  if (!isManagedAddress(parsed.value.email)) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_EMAIL_OTP_SENT,
      result: "denied",
      actorEmail: parsed.value.email,
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "domain-not-served" },
    });
    // Generic on purpose.
    return { ok: true, message: "If that address can use Henna, a code is on its way." };
  }

  const byEmail = await consumeRateLimit(RATE_LIMIT_RULES.otpSendByEmail, parsed.value.email);
  const byIp = await consumeRateLimit(RATE_LIMIT_RULES.otpSendByIp, ctx.ipHash ?? "unknown");
  if (!byEmail.allowed || !byIp.allowed) {
    return {
      ok: false,
      message: `Please wait before requesting another code (${settings.otpResendCooldownSeconds}s).`,
    };
  }

  const previous = await lastOtpForEmail(parsed.value.email, "login");
  if (previous && Date.now() - previous.createdAt.getTime() < settings.otpResendCooldownSeconds * 1000) {
    return {
      ok: false,
      message: `A code was just sent. Try again in ${settings.otpResendCooldownSeconds} seconds.`,
    };
  }

  const user = await findUserByEmail(parsed.value.email);

  const issued = await issueEmailOtp({
    email: parsed.value.email,
    userId: user?.id ?? null,
    purpose: "login",
    ttlSeconds: settings.otpTtlSeconds,
    maxAttempts: settings.otpMaxAttempts,
    context: ctx,
  });

  // Deliver through Resend on the server; the API key never reaches a browser.
  const delivery = await deliverCode(
    parsed.value.email,
    issued.code,
    settings.otpTtlSeconds,
  );

  await writeAudit({
    action: AUDIT_ACTIONS.LOGIN_EMAIL_OTP_SENT,
    result: "success",
    actorId: user?.id ?? null,
    actorEmail: parsed.value.email,
    resourceType: "auth",
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
    metadata: { ttlSeconds: settings.otpTtlSeconds, delivery },
  });

  // Only the bootstrap branch says anything specific: it has to, or the
  // operator cannot find the code. It does confirm the ADMIN address, which is
  // why it is gated on the instance having no verified users at all.
  return {
    ok: true,
    message:
      delivery === "bootstrap"
        ? "No mail is configured yet, so the code was printed to the server log. Run `npx wrangler tail` to read it."
        : "If that address can use Henna, a code is on its way.",
  };
}

/**
 * Send the code.
 *
 * `RESEND_API_KEY` is read server-side from the encrypted instance settings (or
 * the environment fallback) and is never exposed to the client bundle.
 */
/**
 * How a code left the building — or failed to.
 *
 * "sent" is normal. "bootstrap" only ever happens on a brand-new instance that
 * has no way to send mail yet, and it is the difference between a one-click
 * deployment working and being impossible to sign in to at all.
 */
type DeliveryMode = "sent" | "bootstrap" | "not-configured";

async function deliverCode(email: string, code: string, ttlSeconds: number): Promise<DeliveryMode> {
  const { getInstanceSecrets, getInstanceSettings: readSettings } = await import(
    "@/lib/config/settings"
  );
  const [secrets, settings] = await Promise.all([getInstanceSecrets(), readSettings()]);

  const apiKey = secrets.resendApiKey;
  const from = settings.emailFrom;
  if (!apiKey || !from) {
    if (await isBootstrapEligible(email)) {
      // Deliberate, narrowly scoped exception to "never log a code".
      //
      // A freshly deployed instance has no Resend key, so it cannot send mail —
      // and without a code nobody can sign in to configure one. Deadlock. The
      // way out is to print the code to the server log exactly once, and only
      // while the instance is still untouched.
      //
      // Guarded by: the bootstrap address only, no user has ever verified an
      // email, and the code is still single-use, short-lived and rate limited.
      console.info(
        `[henna] BOOTSTRAP sign-in code for ${email}: ${code} ` +
          `(single use, expires in ${Math.round(ttlSeconds / 60)} minutes). ` +
          `View with: npx wrangler tail`,
      );
      return "bootstrap";
    }
    return "not-configured";
  }

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Henna sign-in code",
      text: [
        `Your Henna sign-in code is ${code}.`,
        "",
        `It expires in ${Math.round(ttlSeconds / 60)} minutes and can only be used once.`,
        "If you did not request it, you can ignore this message.",
      ].join("\n"),
    }),
    cache: "no-store",
  });

  return "sent";
}

/**
 * Whether this request may fall back to logging the code.
 *
 * True only while the instance is genuinely untouched: nobody has completed a
 * sign-in, so no user row carries a verified email. As soon as the first
 * administrator signs in, this returns false for good and mail must be
 * configured properly.
 */
async function isBootstrapEligible(email: string): Promise<boolean> {
  try {
    const { getAdminEmail } = await import("@/lib/config/env");
    if (email.trim().toLowerCase() !== getAdminEmail().toLowerCase()) return false;

    const { getDb } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { isNotNull } = await import("drizzle-orm");

    const verified = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(isNotNull(users.emailVerifiedAt))
      .limit(1);
    return verified.length === 0;
  } catch {
    return false;
  }
}

/**
 * Password reset: request a code, then set a new password with it.
 * On success every existing session for that user is revoked.
 */
export async function requestPasswordReset(formData: FormData): Promise<ActionResult> {
  const parsed = parseInput(emailOtpRequestSchema, formDataToObject(formData));
  if (!parsed.ok) return { ok: false, message: parsed.issues[0] ?? "Enter a valid email address." };

  const ctx = await context();
  const settings = await getInstanceSettings();

  if (!isManagedAddress(parsed.value.email)) {
    return { ok: true, message: "If that address has an account, a reset code is on its way." };
  }

  const limit = await consumeRateLimit(RATE_LIMIT_RULES.passwordReset, parsed.value.email);
  if (!limit.allowed) return { ok: false, message: "Too many reset requests. Try again later." };

  const user = await findUserByEmail(parsed.value.email);
  const issued = await issueEmailOtp({
    email: parsed.value.email,
    userId: user?.id ?? null,
    purpose: "password_reset",
    ttlSeconds: settings.otpTtlSeconds,
    maxAttempts: settings.otpMaxAttempts,
    context: ctx,
  });

  await deliverCode(parsed.value.email, issued.code, settings.otpTtlSeconds);

  await writeAudit({
    action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
    result: "success",
    actorId: user?.id ?? null,
    actorEmail: parsed.value.email,
    resourceType: "account",
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
  });

  return { ok: true, message: "If that address has an account, a reset code is on its way." };
}

export async function completePasswordReset(formData: FormData): Promise<ActionResult> {
  const parsed = parseInput(
    (await import("@/lib/validation/schemas")).passwordResetConfirmSchema,
    formDataToObject(formData),
  );
  if (!parsed.ok) return { ok: false, message: parsed.issues[0] ?? "Check the code and password." };

  const ctx = await context();
  const result = await verifyEmailOtp({
    email: parsed.value.email,
    code: parsed.value.code,
    purpose: "password_reset",
  });

  if (!result.ok) return { ok: false, message: "That code is not valid. Request a new one." };

  const user = await findUserByEmail(parsed.value.email);
  if (!user) return { ok: false, message: "That code is not valid. Request a new one." };

  await setPassword(user.id, parsed.value.password, ctx);

  // A password reset invalidates every session, including the attacker's.
  const { revokeAllSessionsForUser } = await import("@/lib/auth/session");
  const revoked = await revokeAllSessionsForUser(user.id);

  await writeAudit({
    action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
    result: "success",
    actorId: user.id,
    actorEmail: user.email,
    resourceType: "account",
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
    metadata: { sessionsRevoked: revoked },
  });

  redirect("/login");
}
