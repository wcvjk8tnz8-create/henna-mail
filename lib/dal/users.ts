import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, type User } from "@/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { getAdminEmail } from "@/lib/config/env";
import type { Principal } from "./types";

/**
 * User records.
 *
 * Every read goes through a DAL function that returns a **minimum DTO** — never
 * the full row — so that a page cannot accidentally render a password hash or a
 * TOTP ciphertext.
 */

export interface UserDto {
  readonly id: string;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly displayName: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly hasPassword: boolean;
  readonly githubLinked: boolean;
}

function toDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
    locked: user.lockedAt !== null,
    disabled: user.disabledAt !== null,
    hasPassword: user.passwordHash !== null,
    githubLinked: user.githubUserId !== null,
  };
}

/** The caller's own profile. */
export async function getOwnProfile(principal: Principal): Promise<UserDto | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, principal.userId));
  return row ? toDto(row) : null;
}

/** Administrator-only listing. */
export async function listUsers(): Promise<readonly UserDto[]> {
  const db = getDb();
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  return rows.map(toDto);
}

export async function getUserById(id: string): Promise<UserDto | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ? toDto(row) : null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ?? null;
}

export async function findUserByGithubId(githubUserId: string): Promise<User | null> {
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.githubUserId, githubUserId));
  return row ?? null;
}

/**
 * Bootstrap the administrator account from the `ADMIN` root setting.
 *
 * Idempotent and safe to call on every boot: it only ever creates the account
 * when it does not exist yet, and it never changes an existing account's role.
 */
export async function ensureBootstrapAdmin(): Promise<{ created: boolean; userId: string | null }> {
  const email = getAdminEmail();
  const existing = await findUserByEmail(email);
  if (existing) {
    return { created: false, userId: existing.id };
  }

  const db = getDb();
  const [created] = await db
    .insert(users)
    .values({ email, role: "admin", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  if (!created) return { created: false, userId: null };

  await writeAudit({
    action: AUDIT_ACTIONS.ACCOUNT_CREATED,
    result: "success",
    actorId: created.id,
    actorEmail: email,
    actorRole: "admin",
    resourceType: "account",
    metadata: { source: "bootstrap-admin" },
  });

  return { created: true, userId: created.id };
}

/**
 * Change a user's role. An administrator cannot demote themselves — that would
 * be the easiest way to strip the instance of its last administrator.
 */
export async function setUserRole(input: {
  readonly actor: Principal;
  readonly targetId: string;
  readonly role: "user" | "admin";
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.actor.userId === input.targetId && input.role !== "admin") {
    return { ok: false, reason: "You cannot remove your own administrator role" };
  }

  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, input.targetId));
  if (!target) return { ok: false, reason: "No such user" };

  await db.update(users).set({ role: input.role, updatedAt: new Date() }).where(eq(users.id, input.targetId));

  await writeAudit({
    action: AUDIT_ACTIONS.ADMIN_USER_ROLE_CHANGED,
    result: "success",
    actorId: input.actor.userId,
    actorEmail: input.actor.email,
    actorRole: input.actor.role,
    resourceType: "user",
    resourceId: input.targetId,
    metadata: { from: target.role, to: input.role, targetEmail: target.email },
  });

  return { ok: true };
}

export async function setUserLock(
  actor: Principal,
  targetId: string,
  locked: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actor.userId === targetId) {
    return { ok: false, reason: "You cannot lock your own account" };
  }
  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, targetId));
  if (!target) return { ok: false, reason: "No such user" };

  await db
    .update(users)
    .set({ lockedAt: locked ? new Date() : null, updatedAt: new Date() })
    .where(eq(users.id, targetId));

  await writeAudit({
    action: locked ? AUDIT_ACTIONS.ADMIN_USER_LOCKED : AUDIT_ACTIONS.ADMIN_USER_UNLOCKED,
    result: "success",
    actorId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: "user",
    resourceId: targetId,
    metadata: { targetEmail: target.email },
  });

  return { ok: true };
}

/**
 * Link a GitHub identity to an existing Henna account.
 *
 * The caller must already be authenticated by another method: Henna never
 * silently merges a GitHub identity into an account that matches by email,
 * because GitHub's "verified" flag is not proof of mailbox ownership in every
 * configuration.
 */
export async function linkGithubIdentity(input: {
  readonly userId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = getDb();
  const clash = await findUserByGithubId(input.githubUserId);
  if (clash && clash.id !== input.userId) {
    return { ok: false, reason: "That GitHub account is already linked elsewhere" };
  }

  await db
    .update(users)
    .set({
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      updatedAt: new Date(),
    })
    .where(eq(users.id, input.userId));

  await writeAudit({
    action: AUDIT_ACTIONS.ACCOUNT_BOUND_GITHUB,
    result: "success",
    actorId: input.userId,
    resourceType: "account",
    resourceId: input.githubUserId,
    metadata: { githubLogin: input.githubLogin },
  });

  return { ok: true };
}

export async function unlinkGithubIdentity(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ githubUserId: null, githubLogin: null, updatedAt: new Date() })
    .where(eq(users.id, userId));

  await writeAudit({
    action: AUDIT_ACTIONS.ACCOUNT_UNBOUND_GITHUB,
    result: "success",
    actorId: userId,
    resourceType: "account",
  });
}

/** Create an account for a GitHub or OTP identity that is not yet known. */
export async function createUser(input: {
  readonly email: string;
  readonly role?: "user" | "admin";
  readonly githubUserId?: string | null;
  readonly githubLogin?: string | null;
  readonly verified?: boolean;
}): Promise<User> {
  const db = getDb();
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      role: input.role ?? "user",
      githubUserId: input.githubUserId ?? null,
      githubLogin: input.githubLogin ?? null,
      emailVerifiedAt: input.verified ? new Date() : null,
    })
    .returning();

  if (!row) throw new Error("Failed to create user");

  await writeAudit({
    action: AUDIT_ACTIONS.ACCOUNT_CREATED,
    result: "success",
    actorId: row.id,
    actorEmail: row.email,
    actorRole: row.role,
    resourceType: "account",
    metadata: { source: input.githubUserId ? "github" : "email-otp" },
  });

  return row;
}

/** Mark an address as proven. */
export async function markEmailVerified(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}
