"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_COOKIE, activateSessionAfterMfa, createSession } from "@/lib/auth/session";
import { buildRequestContext } from "@/lib/request";
import { getInstanceSettings } from "@/lib/config/settings";
import { requirePrincipal } from "@/lib/dal/guards";
import { beginTotpEnrollment, verifyTotpForUser } from "@/lib/dal/totp";
import { issueCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/security/csrf";
import { parseInput, totpVerifySchema, formDataToObject } from "@/lib/validation/schemas";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";

/**
 * Second-factor Server Actions.
 *
 * The critical detail is `activateSessionAfterMfa`: it mints a *new* session id
 * and revokes the pending one, so a token issued before the second factor was
 * satisfied cannot be replayed afterwards.
 */

export interface MfaActionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly secret?: string;
  readonly uri?: string;
  readonly recoveryCodes?: string[];
}

async function context() {
  return buildRequestContext(await headers());
}

export async function beginEnrollment(): Promise<MfaActionResult> {
  const principal = await requirePrincipal();
  const ctx = await context();
  const result = await beginTotpEnrollment(principal, ctx);
  return {
    ok: true,
    message: "Scan the secret with your authenticator app.",
    secret: result.secret,
    uri: result.uri,
    recoveryCodes: [...result.recoveryCodes],
  };
}

async function finish(principal: Awaited<ReturnType<typeof requirePrincipal>>): Promise<never> {
  const settings = await getInstanceSettings();
  const jar = await cookies();
  const pendingId = jar.get("henna_pending_mfa")?.value ?? principal.sessionId;

  const tokens = await activateSessionAfterMfa({
    sessionId: pendingId,
    accessTtlSeconds: settings.sessionTtlSeconds,
    refreshTtlSeconds: settings.refreshTtlSeconds,
  });

  if (tokens) {
    const isProd = process.env.NODE_ENV === "production";
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
    jar.delete("henna_pending_mfa");
  } else {
    // The pending session was already consumed or expired; make a fresh one.
    const fresh = await createSession({
      userId: principal.userId,
      email: principal.email,
      role: principal.role,
      authMethod: principal.amr[0] ?? "password",
      status: "active",
      accessTtlSeconds: settings.sessionTtlSeconds,
      refreshTtlSeconds: settings.refreshTtlSeconds,
    });
    const isProd = process.env.NODE_ENV === "production";
    jar.set(ACCESS_COOKIE, fresh.accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      expires: fresh.accessExpiresAt,
    });
    jar.set("henna_refresh", fresh.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      expires: fresh.refreshExpiresAt,
    });
    jar.set(CSRF_COOKIE, issueCsrfToken(fresh.sessionId), csrfCookieOptions(isProd));
    jar.delete("henna_pending_mfa");
  }

  await writeAudit({
    action: AUDIT_ACTIONS.SESSION_ROTATED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "session",
    ipHash: (await context()).ipHash,
    userAgentHash: (await context()).userAgentHash,
    metadata: { reason: "mfa-satisfied" },
  });

  redirect("/inbox");
}

export async function verifySecondFactor(formData: FormData): Promise<MfaActionResult | undefined> {
  const principal = await requirePrincipal();
  const ctx = await context();
  const parsed = parseInput(totpVerifySchema, formDataToObject(formData));

  if (!parsed.ok) {
    return { ok: false, message: parsed.issues[0] ?? "Enter a 6-digit code." };
  }

  const outcome = await verifyTotpForUser(
    principal,
    { code: parsed.value.code, recoveryCode: parsed.value.recoveryCode },
    ctx,
  );

  if (!outcome.ok) {
    return {
      ok: false,
      message:
        outcome.reason === "rate-limited"
          ? "Too many attempts. Wait a moment and try again."
          : outcome.reason === "replay"
            ? "That code was already used. Wait for the next one."
            : "That code was not accepted.",
    };
  }

  await finish(principal);
}

/** Same as verification, but used while an enrollment is being confirmed. */
export async function confirmEnrollment(formData: FormData): Promise<MfaActionResult | undefined> {
  return verifySecondFactor(formData);
}
