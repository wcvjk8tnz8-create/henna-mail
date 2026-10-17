import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { recoveryCodes, totpSecrets } from "@/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { getInstanceSettings } from "@/lib/config/settings";
import {
  generateRecoveryCodeSet,
  hashRecoveryCode,
  matchRecoveryCode,
  normalise,
  remainingCount,
  shouldPromptRegeneration,
  type StoredRecoveryCode,
} from "@/lib/auth/recovery-codes";
import { generateTotpSecret, verifyTotp } from "@/lib/auth/totp";
import { consumeRateLimit, resetRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import type { RequestContext } from "@/lib/request";
import { AuthzError } from "./types";
import { canDisableTotp, evaluateMfaRequirement } from "./policy";
import type { Principal } from "./types";

/**
 * TOTP and recovery-code data access.
 *
 * Every function here takes a `Principal` that a guard has already authorised,
 * and every security-relevant outcome is written to the audit log. The
 * plaintext TOTP secret is decrypted only inside `verifyTotp` and never leaves
 * this module.
 */

export interface TotpStatus {
  readonly enrolled: boolean;
  readonly confirmed: boolean;
  readonly lastUsedStep: number | null;
  readonly recoveryCodesRemaining: number;
  readonly shouldRegenerateRecoveryCodes: boolean;
}

export async function getTotpStatus(principal: Principal): Promise<TotpStatus> {
  const db = getDb();
  const [secret] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, principal.userId));

  const codes = await db
    .select()
    .from(recoveryCodes)
    .where(eq(recoveryCodes.userId, principal.userId));

  const stored: StoredRecoveryCode[] = codes.map((row) => ({
    id: row.id,
    codeHash: row.codeHash,
    usedAt: row.usedAt,
  }));

  return {
    enrolled: Boolean(secret),
    confirmed: secret?.confirmedAt != null,
    lastUsedStep: secret?.lastUsedStep ?? null,
    recoveryCodesRemaining: remainingCount(stored),
    shouldRegenerateRecoveryCodes: shouldPromptRegeneration(stored),
  };
}

export interface EnrollResult {
  readonly secret: string;
  readonly uri: string;
  readonly recoveryCodes: readonly string[];
}

/**
 * Start enrolment: mint a secret and a fresh recovery-code set.
 *
 * The secret is not "confirmed" until the user proves a first code, so a lost
 * or abandoned enrolment cannot lock anyone out.
 */
export async function beginTotpEnrollment(
  principal: Principal,
  context: RequestContext,
): Promise<EnrollResult> {
  const db = getDb();
  const settings = await getInstanceSettings();
  const enrollment = generateTotpSecret("Henna", principal.email);
  const codeSet = generateRecoveryCodeSet();

  await db
    .insert(totpSecrets)
    .values({
      userId: principal.userId,
      secretEnc: enrollment.encryptedSecret,
      keyId: enrollment.keyId,
      confirmedAt: null,
    })
    .onConflictDoUpdate({
      target: totpSecrets.userId,
      set: { secretEnc: enrollment.encryptedSecret, keyId: enrollment.keyId, confirmedAt: null },
    });

  // Enrolment replaces the whole recovery-code set: codes issued under a
  // previous secret should not outlive it.
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, principal.userId));
  await db.insert(recoveryCodes).values(
    codeSet.hashes.map((codeHash) => ({ userId: principal.userId, codeHash })),
  );

  await writeAudit({
    action: AUDIT_ACTIONS.TOTP_ENROLLED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "mfa",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { stage: "begun", policy: settings.totpPolicy },
  });

  return { secret: enrollment.secret, uri: enrollment.uri, recoveryCodes: codeSet.plaintext };
}

export type VerifyTotpOutcome =
  | { readonly ok: true; readonly confirmed: boolean }
  | { readonly ok: false; readonly reason: "rate-limited" | "invalid" | "replay" | "expired" | "tampered" | "not-enrolled"; readonly retryAfterSeconds?: number };

/**
 * Verify a TOTP code (or a recovery code) and, on success, record the step so
 * the same code can never be used again.
 */
export async function verifyTotpForUser(
  principal: Principal,
  input: { code?: string; recoveryCode?: string },
  context: RequestContext,
): Promise<VerifyTotpOutcome> {
  const db = getDb();

  const limit = await consumeRateLimit(RATE_LIMIT_RULES.totpVerify, principal.userId);
  if (!limit.allowed) {
    await writeAudit({
      action: AUDIT_ACTIONS.TOTP_VERIFY_FAILED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "mfa",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { reason: "rate-limited" },
    });
    return { ok: false, reason: "rate-limited", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const [secret] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, principal.userId));

  if (!secret) {
    await writeAudit({
      action: AUDIT_ACTIONS.TOTP_VERIFY_FAILED,
      result: "error",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "mfa",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { reason: "not-enrolled" },
    });
    return { ok: false, reason: "not-enrolled" };
  }

  // Recovery-code path.
  if (input.recoveryCode && !input.code) {
    const codes = await db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, principal.userId), isNull(recoveryCodes.usedAt)));

    const match = matchRecoveryCode(normalise(input.recoveryCode), codes.map((row) => ({
      id: row.id,
      codeHash: row.codeHash,
      usedAt: row.usedAt,
    })));

    if (!match.ok) {
      await writeAudit({
        action: AUDIT_ACTIONS.TOTP_VERIFY_FAILED,
        result: "denied",
        actorId: principal.userId,
        actorEmail: principal.email,
        resourceType: "mfa",
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
        metadata: { method: "recovery-code", reason: match.reason },
      });
      return { ok: false, reason: "invalid" };
    }

    await db
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(eq(recoveryCodes.id, match.matchedId));

    await writeAudit({
      action: AUDIT_ACTIONS.RECOVERY_CODE_USED,
      result: "success",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "mfa",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { remaining: remainingCount(codes) - 1 },
    });

    await resetRateLimit(RATE_LIMIT_RULES.totpVerify, principal.userId);
    return { ok: true, confirmed: secret.confirmedAt != null };
  }

  const result = verifyTotp(secret.secretEnc, input.code ?? "", secret.lastUsedStep);

  if (!result.ok) {
    await writeAudit({
      action: AUDIT_ACTIONS.TOTP_VERIFY_FAILED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "mfa",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { method: "totp", reason: result.reason },
    });
    return { ok: false, reason: result.reason };
  }

  const now = new Date();
  await db
    .update(totpSecrets)
    .set({
      lastUsedStep: result.step,
      // The first successful code is what turns enrolment into a real factor.
      confirmedAt: secret.confirmedAt ?? now,
    })
    .where(eq(totpSecrets.userId, principal.userId));

  await writeAudit({
    action: AUDIT_ACTIONS.TOTP_VERIFY_SUCCESS,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "mfa",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { drift: result.drift, firstConfirmation: secret.confirmedAt === null },
  });

  await resetRateLimit(RATE_LIMIT_RULES.totpVerify, principal.userId);
  return { ok: true, confirmed: true };
}

/**
 * Disable TOTP.
 *
 * The caller must have already re-verified a code (or a recovery code); this
 * function refuses when that proof is absent, so a stolen session cannot simply
 * switch the second factor off. Administrators can never disable theirs.
 */
export async function disableTotp(
  principal: Principal,
  proof: { code?: string; recoveryCode?: string },
  context: RequestContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (principal.role === "admin") {
    await writeAudit({
      action: AUDIT_ACTIONS.TOTP_DISABLED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "mfa",
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { reason: "administrators-must-keep-totp" },
    });
    return { ok: false, reason: "Administrators cannot disable TOTP" };
  }

  if (!canDisableTotp({ role: principal.role, totpConfirmed: true }, "optional")) {
    return { ok: false, reason: "TOTP cannot be disabled for this account" };
  }

  if (!proof.code && !proof.recoveryCode) {
    return { ok: false, reason: "Confirm with a TOTP code or a recovery code first" };
  }

  const verified = await verifyTotpForUser(principal, proof, context);
  if (!verified.ok) {
    return { ok: false, reason: "The confirmation code was not accepted" };
  }

  const db = getDb();
  await db.delete(totpSecrets).where(eq(totpSecrets.userId, principal.userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, principal.userId));

  await writeAudit({
    action: AUDIT_ACTIONS.TOTP_DISABLED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    resourceType: "mfa",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });

  return { ok: true };
}

/** Replace the recovery-code set. Plaintext is returned exactly once. */
export async function regenerateRecoveryCodes(
  principal: Principal,
  context: RequestContext,
): Promise<readonly string[]> {
  const db = getDb();
  const codeSet = generateRecoveryCodeSet();

  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, principal.userId));
  await db.insert(recoveryCodes).values(
    codeSet.hashes.map((codeHash) => ({ userId: principal.userId, codeHash })),
  );

  await writeAudit({
    action: AUDIT_ACTIONS.RECOVERY_CODE_REGENERATED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    resourceType: "mfa",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { count: codeSet.plaintext.length },
  });

  return codeSet.plaintext;
}

/**
 * Whether this account still owes a second factor, given the instance policy.
 * Used by the login flow before a session is made usable.
 */
export async function mfaOwedFor(principal: Principal): Promise<boolean> {
  const settings = await getInstanceSettings();
  const status = await getTotpStatus(principal);
  const policy =
    principal.role === "admin" && settings.totpPolicy === "optional"
      ? "admin-only"
      : settings.totpPolicy;

  const decision = evaluateMfaRequirement(
    { role: principal.role, totpConfirmed: status.confirmed },
    policy,
  );
  return decision.required;
}

export { hashRecoveryCode };

/** Re-exported so route handlers do not need to know about AuthzError shapes. */
export { AuthzError };
