import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { totpSecrets } from "@/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS, type AuditAction } from "@/lib/audit/events";
import { getInstanceSettings } from "@/lib/config/settings";
import { buildRequestContext } from "@/lib/request";
import { evaluateMfaRequirement } from "./policy";
import { resolveSessionFromCookies, resolveSessionOrFail, type ResolvedContext } from "./session";
import { AuthzError, type Principal } from "./types";

/**
 * DAL guards.
 *
 * Every protected Server Action, Route Handler and Server Component starts by
 * calling one of these. They are the single authorisation enforcement point;
 * `middleware.ts` performs optimistic redirects only and is never relied upon
 * for security (on Cloudflare Workers Node.js middleware does not even run).
 *
 * Denials are audited at the point of decision, with the actor's identity when
 * it is known and with a null actor when it is not — the failed attempt is
 * exactly what an incident responder needs.
 */

async function requestContext() {
  return buildRequestContext(await headers());
}

async function auditDenial(input: {
  /** Any denial action; ACCESS_DENIED is the default. */
  action?: AuditAction;
  principal: Principal | null;
  reason: string;
  resourceType?: string;
  resourceId?: string | null;
}): Promise<void> {
  const ctx = await requestContext();
  await writeAudit({
    action: input.action ?? AUDIT_ACTIONS.ACCESS_DENIED,
    result: "denied",
    actorId: input.principal?.userId ?? null,
    actorEmail: input.principal?.email ?? null,
    actorRole: input.principal?.role ?? null,
    resourceType: input.resourceType ?? "system",
    resourceId: input.resourceId ?? null,
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
    metadata: { reason: input.reason },
  });
}

/** Returns the current principal, or `null` when the request is anonymous. */
export async function getOptionalPrincipal(): Promise<Principal | null> {
  const resolved = await resolveSessionFromCookies();
  return resolved?.principal ?? null;
}

/**
 * Require a fully authenticated principal.
 *
 * Throws `AuthzError('unauthenticated')` when there is no session and
 * `AuthzError('mfa-required')` when the second factor is still outstanding, so
 * callers can send the user to /mfa instead of /login.
 */
export async function requirePrincipal(): Promise<Principal> {
  let resolved: ResolvedContext;
  try {
    resolved = await resolveSessionOrFail();
  } catch (error) {
    if (error instanceof AuthzError) {
      await auditDenial({
        action: AUDIT_ACTIONS.ACCESS_DENIED,
        principal: null,
        reason: error.kind,
      });
    }
    throw error;
  }

  if (!resolved.principal.mfaSatisfied) {
    throw new AuthzError("mfa-required");
  }
  return resolved.principal;
}

/**
 * `requireMfaIfRequired()` — the specification's named gate.
 *
 * Given a principal whose primary authentication succeeded, decide whether a
 * usable session may be established. Returns the principal when the session is
 * complete; throws `AuthzError('mfa-required')` with a reason when the second
 * factor (or its enrolment) is still owed.
 */
export async function requireMfaIfRequired(principal: Principal): Promise<Principal> {
  const settings = await getInstanceSettings();

  // Administrators are always, unconditionally subject to at least
  // `admin-only`, regardless of what the instance policy says.
  const effectivePolicy =
    principal.role === "admin" && settings.totpPolicy === "optional"
      ? "admin-only"
      : settings.totpPolicy;

  const totpConfirmed = await isTotpConfirmed(principal.userId);

  const decision = evaluateMfaRequirement(
    { role: principal.role, totpConfirmed },
    effectivePolicy,
  );

  if (decision.required && !principal.mfaSatisfied) {
    await auditDenial({
      action: AUDIT_ACTIONS.TOTP_REQUIRED_DENIED as AuditAction,
      principal,
      reason: decision.reason,
      resourceType: "session",
      resourceId: principal.sessionId,
    });
    throw new AuthzError("mfa-required", decision.reason);
  }

  return principal;
}

/**
 * Whether the user has a confirmed TOTP enrolment.
 *
 * Queried directly here rather than through lib/dal/totp.ts to avoid an import
 * cycle; both modules read the same `totp_secrets` row.
 */
async function isTotpConfirmed(userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ confirmedAt: totpSecrets.confirmedAt })
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, userId));
  return row?.confirmedAt != null;
}

/**
 * Require an administrator.
 *
 * Note the ordering: authentication first, then MFA, then role. An
 * administrator whose second factor is outstanding has no administrative
 * authority at all.
 */
export async function requireAdmin(): Promise<Principal> {
  const principal = await requirePrincipal();
  if (principal.role !== "admin") {
    await auditDenial({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      principal,
      reason: "not-admin",
      resourceType: "admin",
    });
    throw new AuthzError("forbidden", "Administrator role required");
  }
  await requireMfaIfRequired(principal);
  return principal;
}

/**
 * Require that the caller is the owner of a resource, or an administrator.
 * Always returns the *minimum* DTO the caller is allowed to see.
 */
export async function requireOwnershipOrAdmin(
  resource: { userId: string },
  resourceType: string,
  resourceId?: string | null,
): Promise<Principal> {
  const principal = await requirePrincipal();
  if (principal.role !== "admin" && principal.userId !== resource.userId) {
    await auditDenial({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      principal,
      reason: "not-owner",
      resourceType,
      resourceId: resourceId ?? resource.userId,
    });
    throw new AuthzError("forbidden", "You may only access your own resources");
  }
  return principal;
}

/** Convenience for pages: redirect targets derived from an AuthzError. */
export function redirectTargetFor(error: AuthzError): string {
  switch (error.kind) {
    case "unauthenticated":
    case "session-expired":
      return "/login";
    case "mfa-required":
      return "/mfa";
    case "forbidden":
    case "account-disabled":
    case "account-locked":
      return "/login?error=denied";
  }
}

/** Re-exported so callers can import the guard and the error together. */
export { AuthzError } from "./types";
