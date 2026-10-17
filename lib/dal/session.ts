import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, type SessionRow } from "@/db/schema";
import {
  ACCESS_COOKIE,
  findSessionById,
  verifyAccessToken,
  type AccessTokenClaims,
} from "@/lib/auth/session";
import { AuthzError, type Principal } from "./types";

/**
 * Session resolution — the entry point of the DAL.
 *
 * A cookie is never trusted on its own: the JWT is verified, then the session
 * row it points at is re-read from PostgreSQL and its status, expiry and
 * revocation are checked, then the user row's own flags are checked. Any
 * mismatch is treated as unauthenticated. This is why a stolen access token
 * stops working the moment an administrator revokes the session, even though
 * the token's own signature is still valid.
 */

export interface ResolvedContext {
  readonly principal: Principal;
  readonly session: SessionRow;
  readonly claims: AccessTokenClaims;
}

/** Resolve a session from a raw access token, without touching cookies. */
export async function resolveSessionFromToken(token: string | null): Promise<ResolvedContext | null> {
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  const session = await findSessionById(claims.sid);
  if (!session) return null;
  if (session.status === "revoked") return null;
  if (session.accessExpiresAt.getTime() <= Date.now()) return null;

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user) return null;
  if (user.disabledAt !== null) return null;

  // The JWT carries a snapshot of the role; the database is authoritative.
  const principal: Principal = {
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionId: session.id,
    amr: claims.amr,
    mfaSatisfied: session.status === "active" && session.mfaSatisfiedAt !== null,
    emailVerified: user.emailVerifiedAt !== null,
  };

  return { principal, session, claims };
}

/** Resolve the current request's session from cookies. */
export async function resolveSessionFromCookies(): Promise<ResolvedContext | null> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value ?? null;
  return resolveSessionFromToken(token);
}

/**
 * Like `resolveSessionFromCookies` but reports *why* there is no session.
 * Used by guards so they can distinguish "log in" from "complete MFA" from
 * "your account is disabled".
 */
export async function resolveSessionOrFail(): Promise<ResolvedContext> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value ?? null;

  if (!token) throw new AuthzError("unauthenticated");
  const claims = await verifyAccessToken(token);
  if (!claims) throw new AuthzError("unauthenticated");

  const session = await findSessionById(claims.sid);
  if (!session) throw new AuthzError("session-expired");
  if (session.status === "revoked") throw new AuthzError("session-expired");
  if (session.accessExpiresAt.getTime() <= Date.now()) throw new AuthzError("session-expired");

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user) throw new AuthzError("unauthenticated");
  if (user.disabledAt !== null) throw new AuthzError("account-disabled");
  if (user.lockedAt !== null) throw new AuthzError("account-locked");

  const principal: Principal = {
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionId: session.id,
    amr: claims.amr,
    mfaSatisfied: session.status === "active" && session.mfaSatisfiedAt !== null,
    emailVerified: user.emailVerifiedAt !== null,
  };

  return { principal, session, claims };
}
