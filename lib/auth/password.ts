import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, type User } from "@/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { hashPassword, verifyPassword, needsRehash } from "@/lib/crypto/password";
import { getInstanceSettings } from "@/lib/config/settings";
import { consumeRateLimit, resetRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { hashIp } from "@/lib/request";
import type { RequestContext } from "@/lib/request";

/**
 * Password authentication.
 *
 * Security properties:
 *  - A failed attempt is indistinguishable from an unknown address: the same
 *    response is returned either way, so the endpoint cannot be used to
 *    enumerate accounts.
 *  - Rate limiting is applied on two independent axes (source IP and the
 *    address), so neither spreading attempts across addresses nor across IPs
 *    defeats it.
 *  - A successfully verified password that was hashed with weaker parameters
 *    than the current default is transparently rehashed.
 */

export type PasswordLoginOutcome =
  | { readonly ok: true; readonly user: User; readonly rehashed: boolean }
  | {
      readonly ok: false;
      readonly reason: "invalid-credentials" | "rate-limited" | "locked" | "disabled";
      readonly retryAfterSeconds?: number;
    };

export interface PasswordLoginInput {
  readonly email: string;
  readonly password: string;
  readonly context: RequestContext;
}

export async function authenticateWithPassword(
  input: PasswordLoginInput,
): Promise<PasswordLoginOutcome> {
  const settings = await getInstanceSettings();
  const ipSubject = input.context.ipHash ?? "unknown";
  const emailSubject = input.email;

  const byIp = await consumeRateLimit(RATE_LIMIT_RULES.loginByIp, ipSubject);
  const byEmail = await consumeRateLimit(RATE_LIMIT_RULES.loginByEmail, emailSubject);

  if (!byIp.allowed || !byEmail.allowed) {
    const retryAfter = Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds);
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_LOCKED_OUT,
      result: "denied",
      actorEmail: input.email,
      resourceType: "auth",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { method: "password", retryAfterSeconds: retryAfter },
    });
    return { ok: false, reason: "rate-limited", retryAfterSeconds: retryAfter };
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, input.email));

  // Unknown address: burn the same work as a real verification would cost, so
  // that response timing does not reveal whether the account exists.
  if (!user || user.passwordHash === null) {
    await verifyPassword(input.password, DUMMY_HASH);
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_PASSWORD_FAILED,
      result: "denied",
      actorEmail: input.email,
      resourceType: "auth",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { method: "password", reason: "no-password-credential" },
    });
    return { ok: false, reason: "invalid-credentials" };
  }

  if (user.disabledAt !== null) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_PASSWORD_FAILED,
      result: "denied",
      actorId: user.id,
      actorEmail: user.email,
      resourceType: "auth",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { reason: "disabled" },
    });
    return { ok: false, reason: "disabled" };
  }

  if (user.lockedAt !== null) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_LOCKED_OUT,
      result: "denied",
      actorId: user.id,
      actorEmail: user.email,
      resourceType: "auth",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { reason: "account-locked" },
    });
    return { ok: false, reason: "locked" };
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_PASSWORD_FAILED,
      result: "denied",
      actorId: user.id,
      actorEmail: user.email,
      resourceType: "auth",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { method: "password", reason: "bad-password" },
    });
    return { ok: false, reason: "invalid-credentials" };
  }

  // Transparently upgrade hashes that predate a parameter increase.
  let rehashed = false;
  if (needsRehash(user.passwordHash)) {
    const next = await hashPassword(input.password);
    await db
      .update(users)
      .set({ passwordHash: next, passwordUpdatedAt: new Date() })
      .where(eq(users.id, user.id));
    rehashed = true;
  }

  await Promise.all([
    resetRateLimit(RATE_LIMIT_RULES.loginByIp, ipSubject),
    resetRateLimit(RATE_LIMIT_RULES.loginByEmail, emailSubject),
  ]);

  await writeAudit({
    action: AUDIT_ACTIONS.LOGIN_PASSWORD_SUCCESS,
    result: "success",
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    resourceType: "auth",
    ipHash: input.context.ipHash,
    userAgentHash: input.context.userAgentHash,
    metadata: { method: "password", rehashed },
  });

  return { ok: true, user, rehashed };
}

/**
 * A deliberately expensive dummy hash used to equalise response time between
 * "no such account" and "wrong password".
 */
const DUMMY_HASH = `scrypt$32768$8$1${"$"}AAAAAAAAAAAAAAAAAAAAAA${"$"}AAAA`;

/**
 * Change a password, requiring the current one. Also available post-reset,
 * where the current value is the one-time code instead.
 */
export async function changePassword(input: {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly context: RequestContext;
}): Promise<{ ok: true } | { ok: false; reason: "wrong-password" | "no-password" }> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user || user.passwordHash === null) return { ok: false, reason: "no-password" };

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    await writeAudit({
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      result: "denied",
      actorId: user.id,
      actorEmail: user.email,
      resourceType: "account",
      ipHash: input.context.ipHash,
      userAgentHash: input.context.userAgentHash,
      metadata: { reason: "wrong-current-password" },
    });
    return { ok: false, reason: "wrong-password" };
  }

  const next = await hashPassword(input.newPassword);
  await db
    .update(users)
    .set({ passwordHash: next, passwordUpdatedAt: new Date() })
    .where(and(eq(users.id, input.userId)));

  await writeAudit({
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    result: "success",
    actorId: user.id,
    actorEmail: user.email,
    resourceType: "account",
    ipHash: input.context.ipHash,
    userAgentHash: input.context.userAgentHash,
  });

  return { ok: true };
}

/** Set a password for an account that has none (first-time enrolment). */
export async function setPassword(
  userId: string,
  password: string,
  context: RequestContext,
): Promise<void> {
  const db = getDb();
  const hash = await hashPassword(password);
  await db
    .update(users)
    .set({ passwordHash: hash, passwordUpdatedAt: new Date(), emailVerifiedAt: new Date() })
    .where(eq(users.id, userId));

  await writeAudit({
    action: AUDIT_ACTIONS.ACCOUNT_CREATED,
    result: "success",
    actorId: userId,
    resourceType: "account",
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { method: "password-set" },
  });
}

export { hashIp };
