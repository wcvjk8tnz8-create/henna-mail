import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getBaseUrl, rawEnv } from "@/lib/config/env";
import { getInstanceSecrets, getInstanceSettings } from "@/lib/config/settings";
import {
  OAUTH_STATE_COOKIE,
  buildRedirectUri,
  exchangeCodeForToken,
  fetchGithubOrgs,
  fetchGithubProfile,
  fetchPrimaryVerifiedEmail,
  isAllowedRedirectUri,
  isStateExpired,
  stateMatches,
  type OAuthStateRecord,
} from "@/lib/auth/github";
import { createSession, ACCESS_COOKIE } from "@/lib/auth/session";
import { buildRequestContext } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { consumeRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { evaluateRegistration } from "@/lib/dal/policy";
import { createUser, findUserByGithubId, findUserByEmail, markEmailVerified } from "@/lib/dal/users";
import { getTotpStatus } from "@/lib/dal/totp";
import { issueCsrfToken, CSRF_COOKIE, csrfCookieOptions } from "@/lib/security/csrf";
import { parseInput, githubCallbackSchema, paramsToObject } from "@/lib/validation/schemas";

/**
 * GitHub OAuth callback — fixed at /api/auth/callback/github.
 *
 * Controls applied in order:
 *  1. rate limit by source IP;
 *  2. Zod parse of the query string;
 *  3. exact-match redirect_uri (GitHub compares it literally);
 *  4. constant-time `state` comparison against the stored single-use value;
 *  5. one-shot code exchange — any failure is terminal for that code;
 *  6. `github_user_id` as the only binding key;
 *  7. a primary **and verified** email address, or the attempt is refused;
 *  8. registration control (closed / invite-only / allowlist);
 *  9. a pending session until the second factor is satisfied.
 *
 * An email that matches an existing account never silently takes it over: the
 * user is asked to sign in with their existing method and link GitHub
 * themselves.
 */

interface StoredState {
  value: string;
  createdAt: number;
  redirectAfter: string;
}

export async function GET(request: NextRequest) {
  const base = getBaseUrl(request.nextUrl.origin);
  const ctx = buildRequestContext(request.headers);

  const limit = await consumeRateLimit(
    RATE_LIMIT_RULES.githubCallbackByIp,
    ctx.ipHash ?? "unknown",
  );
  if (!limit.allowed) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "rate-limited" },
    });
    return NextResponse.redirect(new URL("/login?error=locked", base));
  }

  const parsed = parseInput(
    githubCallbackSchema,
    paramsToObject(request.nextUrl.searchParams),
  );
  if (!parsed.ok) {
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  if (parsed.value.error) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "provider-error", error: parsed.value.error },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  // (3) redirect_uri must match exactly.
  if (!isAllowedRedirectUri(buildRedirectUri())) {
    // Guards against a misconfigured AUTH_URL rather than an attacker-supplied
    // value, but fail closed either way.
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  // (4) state must match, in constant time, and must not be stale.
  const jar = await cookies();
  const rawState = jar.get(OAUTH_STATE_COOKIE)?.value;
  let stored: StoredState | null = null;
  if (rawState) {
    try {
      const candidate: unknown = JSON.parse(rawState);
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as StoredState).value === "string" &&
        typeof (candidate as StoredState).createdAt === "number"
      ) {
        stored = candidate as StoredState;
      }
    } catch {
      stored = null;
    }
  }

  // Consumed regardless of outcome: a state value is single use.
  jar.delete(OAUTH_STATE_COOKIE);

  if (!stored || !stateMatches(stored.value, parsed.value.state)) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_STATE_INVALID,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: stored ? "mismatch" : "missing" },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  if (isStateExpired(stored as OAuthStateRecord)) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_STATE_INVALID,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "expired" },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  if (!parsed.value.code) {
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  const settings = await getInstanceSettings();
  const secrets = await getInstanceSecrets();
  const clientId = settings.githubClientId ?? rawEnv().GITHUB_CLIENT_ID;
  const clientSecret = secrets.githubClientSecret ?? rawEnv().GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  // (5) one-shot exchange.
  const token = await exchangeCodeForToken({
    code: parsed.value.code,
    clientId,
    clientSecret,
    redirectUri: buildRedirectUri(),
  });

  if (!token) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "token-exchange-failed" },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  const [profile, orgs] = await Promise.all([fetchGithubProfile(token), fetchGithubOrgs(token)]);
  if (!profile) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
      result: "denied",
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: "profile-unavailable" },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  const githubUserId = String(profile.id);

  // (6) bind on the immutable id, never the email or the login.
  let user = await findUserByGithubId(githubUserId);

  if (!user) {
    // (7) primary *and* verified email only.
    const email = await fetchPrimaryVerifiedEmail(token);
    if (!email) {
      await writeAudit({
        action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
        result: "denied",
        resourceType: "auth",
        ipHash: ctx.ipHash,
        userAgentHash: ctx.userAgentHash,
        metadata: { reason: "no-verified-primary-email", githubUserId },
      });
      return NextResponse.redirect(new URL("/login?error=denied", base));
    }

    const byEmail = await findUserByEmail(email);
    if (byEmail) {
      // Never silently take over an account that merely shares the address.
      await writeAudit({
        action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
        result: "denied",
        actorId: byEmail.id,
        actorEmail: byEmail.email,
        resourceType: "auth",
        ipHash: ctx.ipHash,
        userAgentHash: ctx.userAgentHash,
        metadata: { reason: "email-conflict-requires-explicit-link", githubUserId },
      });
      return NextResponse.redirect(new URL("/login?error=link-required", base));
    }

    // (8) registration control for brand-new accounts.
    const decision = evaluateRegistration(
      {
        githubLogin: profile.login,
        githubOrgs: orgs,
        email,
        existingAccount: false,
      },
      settings.registrationMode,
      settings.githubAllowedUsers,
      settings.githubAllowedOrgs,
    );

    if (!decision.allowed) {
      await writeAudit({
        action: AUDIT_ACTIONS.LOGIN_GITHUB_DENIED_NOT_ALLOWED,
        result: "denied",
        actorEmail: email,
        resourceType: "auth",
        ipHash: ctx.ipHash,
        userAgentHash: ctx.userAgentHash,
        metadata: { reason: decision.reason, githubLogin: profile.login, orgs },
      });
      return NextResponse.redirect(new URL("/login?error=denied", base));
    }

    user = await createUser({
      email,
      githubUserId,
      githubLogin: profile.login,
      verified: true,
    });
  }

  if (user.disabledAt !== null || user.lockedAt !== null) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_GITHUB_FAILED,
      result: "denied",
      actorId: user.id,
      actorEmail: user.email,
      resourceType: "auth",
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { reason: user.disabledAt ? "disabled" : "locked" },
    });
    return NextResponse.redirect(new URL("/login?error=denied", base));
  }

  if (user.emailVerifiedAt === null) {
    await markEmailVerified(user.id);
  }

  // (9) pending session until the second factor is satisfied.
  const status = await getTotpStatus({
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionId: "",
    amr: ["github"],
    mfaSatisfied: false,
    emailVerified: true,
  });

  const policy =
    user.role === "admin" && settings.totpPolicy === "optional"
      ? "admin-only"
      : settings.totpPolicy;
  const owesMfa =
    policy === "required" ? true : policy === "admin-only" ? user.role === "admin" : status.confirmed;

  const tokens = await createSession({
    userId: user.id,
    email: user.email,
    role: user.role,
    authMethod: "github",
    status: owesMfa ? "pending_mfa" : "active",
    accessTtlSeconds: settings.sessionTtlSeconds,
    refreshTtlSeconds: settings.refreshTtlSeconds,
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
  });

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

  if (owesMfa) {
    jar.set("henna_pending_mfa", tokens.sessionId, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  }

  await writeAudit({
    action: AUDIT_ACTIONS.LOGIN_GITHUB_SUCCESS,
    result: "success",
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    resourceType: "auth",
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
    metadata: { githubUserId, mfaRequired: owesMfa },
  });

  return NextResponse.redirect(new URL(owesMfa ? "/mfa" : (stored?.redirectAfter ?? "/inbox"), base));
}
