import type { AuthMethod, RegistrationMode, TotpPolicy } from "@/lib/config/schema";

/**
 * Pure authorisation decisions.
 *
 * These functions touch no database and no request object. They exist so that
 * the rules — which are the part of Henna most worth getting right — can be
 * tested exhaustively without a Postgres instance, and so that the DAL's
 * database-touching code has exactly one place to ask "is this allowed?".
 */

export type UserRole = "user" | "admin";

/* ------------------------------------------------------------ MFA policy */

export interface MfaSubject {
  readonly role: UserRole;
  /** True once the user has successfully proven a first TOTP code. */
  readonly totpConfirmed: boolean;
}

export type MfaRequirement =
  /** No second factor needed; the session may be established immediately. */
  | { readonly required: false; readonly reason: "not-required" }
  /** The user has not enrolled TOTP yet but policy demands it. */
  | { readonly required: true; readonly reason: "enrollment-required"; readonly policy: TotpPolicy }
  /** TOTP is enrolled; a code must be supplied before the session is usable. */
  | { readonly required: true; readonly reason: "verification-required"; readonly policy: TotpPolicy };

/**
 * Decide whether a second factor stands between a successful primary
 * authentication and a usable session.
 *
 * Policy semantics:
 *  - `admin-only`  (default): administrators must enrol and verify TOTP;
 *                  ordinary users may opt in.
 *  - `required`:   everyone must enrol and verify.
 *  - `optional`:   nobody is forced; anyone who has enrolled must verify.
 */
export function evaluateMfaRequirement(
  subject: MfaSubject,
  policy: TotpPolicy,
): MfaRequirement {
  const forced =
    policy === "required" ? true : policy === "admin-only" ? subject.role === "admin" : false;

  if (!subject.totpConfirmed) {
    return forced
      ? { required: true, reason: "enrollment-required", policy }
      : { required: false, reason: "not-required" };
  }
  return { required: true, reason: "verification-required", policy };
}

/** An administrator may never turn their own second factor off. */
export function canDisableTotp(subject: MfaSubject, policy: TotpPolicy): boolean {
  if (subject.role !== "admin") return true;
  // Administrators are always subject to at least `admin-only`.
  return false;
}

/* ------------------------------------------------------- registration */

export interface RegistrationSubject {
  /** Present for GitHub logins; null for password and email-OTP logins. */
  readonly githubLogin?: string | null;
  readonly githubOrgs?: readonly string[];
  readonly email?: string | null;
  readonly hasInvite?: boolean;
  /** True when a Henna account already exists for this identity. */
  readonly existingAccount: boolean;
}

export type RegistrationDecision =
  | { readonly allowed: true; readonly reason: "existing-account" | "invited" | "allowlist" | "open" }
  | {
      readonly allowed: false;
      readonly reason:
        | "closed"
        | "invite-required"
        | "user-not-allowlisted"
        | "org-not-allowlisted"
        | "no-identity";
    };

/**
 * Registration control. Existing accounts are never affected: this gate is
 * about who may *create* an account, not who may sign in.
 */
export function evaluateRegistration(
  subject: RegistrationSubject,
  mode: RegistrationMode,
  allowedUsers: readonly string[],
  allowedOrgs: readonly string[],
): RegistrationDecision {
  if (subject.existingAccount) return { allowed: true, reason: "existing-account" };

  switch (mode) {
    case "closed":
      return { allowed: false, reason: "closed" };
    case "invite-only":
      return subject.hasInvite
        ? { allowed: true, reason: "invited" }
        : { allowed: false, reason: "invite-required" };
    case "allowlist": {
      if (allowedUsers.length === 0 && allowedOrgs.length === 0) {
        // A misconfigured allowlist must fail closed, not open.
        return { allowed: false, reason: "user-not-allowlisted" };
      }
      const login = subject.githubLogin?.toLowerCase();
      if (login && allowedUsers.some((u) => u.toLowerCase() === login)) {
        return { allowed: true, reason: "allowlist" };
      }
      const orgs = subject.githubOrgs ?? [];
      if (orgs.some((org) => allowedOrgs.some((o) => o.toLowerCase() === org.toLowerCase()))) {
        return { allowed: true, reason: "allowlist" };
      }
      return {
        allowed: false,
        reason: login ? "user-not-allowlisted" : "org-not-allowlisted",
      };
    }
  }
}

/* ----------------------------------------------------------- access */

export interface ResourceOwner {
  readonly ownerId: string;
}

/**
 * Resource-level authorisation. Administrators may reach any resource; everyone
 * else only their own.
 */
export function canAccessOwnedResource(
  principalRole: UserRole,
  principalId: string,
  ownerId: string,
): boolean {
  if (principalRole === "admin") return true;
  return principalId === ownerId;
}

/** Administrators only. */
export function isAdmin(role: UserRole): boolean {
  return role === "admin";
}

/* ------------------------------------------------- enabled auth methods */

/**
 * Whether a login attempt may use a method. A disabled method is refused even
 * if the credentials are valid, and the refusal is audited.
 */
export function isMethodEnabled(
  method: AuthMethod,
  enabled: readonly AuthMethod[],
): boolean {
  return enabled.includes(method);
}

/* ------------------------------------------------------ password policy */

export interface PasswordPolicyInput {
  readonly minLength: number;
  readonly requireComplexity: boolean;
}

export type PasswordVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "too-short" | "too-long" | "no-letter" | "no-digit" | "no-symbol" };

export const PASSWORD_MAX_LENGTH = 128;

export function evaluatePasswordPolicy(
  password: string,
  policy: PasswordPolicyInput,
): PasswordVerdict {
  if (password.length < policy.minLength) return { ok: false, reason: "too-short" };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, reason: "too-long" };
  if (policy.requireComplexity) {
    if (!/[A-Za-z]/.test(password)) return { ok: false, reason: "no-letter" };
    if (!/[0-9]/.test(password)) return { ok: false, reason: "no-digit" };
    if (!/[^A-Za-z0-9]/.test(password)) return { ok: false, reason: "no-symbol" };
  }
  return { ok: true };
}
