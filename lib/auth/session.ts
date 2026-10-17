import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users, type SessionRow } from "@/db/schema";
import { getJwtSecret } from "@/lib/config/env";
import { keyedDigest } from "@/lib/crypto/constant-time";
import { getKeyring } from "@/lib/crypto/keyring";
import { randomBytesOf, toBase64Url } from "@/lib/crypto/random";

/**
 * Session mechanics.
 *
 * Design constraints from the specification:
 *  - Access tokens live at most 15 minutes.
 *  - Refresh tokens rotate on every use; the previous token dies immediately.
 *  - The session identifier is rotated when authentication completes (including
 *    the MFA step), so a token issued before the second factor was satisfied
 *    cannot be replayed afterwards.
 *  - Refresh tokens are stored only as keyed digests.
 *
 * The access token is a signed JWT carrying the minimum claims needed to find
 * the authoritative session row. Authorisation decisions are always re-checked
 * against the database through the DAL — the JWT never grants access by itself.
 */

export const ACCESS_COOKIE = "henna_session";
export const REFRESH_COOKIE = "henna_refresh";
export const PENDING_MFA_COOKIE = "henna_pending_mfa";

const ISSUER = "henna";
const AUDIENCE = "henna-web";

export type PrimaryAuthMethod = "password" | "github" | "email_otp";

export interface AccessTokenClaims {
  /** Session identifier (rotated on login and on MFA success). */
  readonly sid: string;
  readonly sub: string;
  readonly email: string;
  readonly role: "user" | "admin";
  /** Authentication method reference: which primary method was used. */
  readonly amr: readonly PrimaryAuthMethod[];
  /** True only once TOTP (or a recovery code) has been satisfied. */
  readonly mfa: boolean;
  readonly iat: number;
  readonly exp: number;
}

export interface IssuedTokens {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getJwtSecret());
}

function pepper(): Buffer {
  // Reuse the active credential key as the pepper for refresh-token digests so
  // that rotating credentials invalidates outstanding refresh tokens too.
  return Buffer.from(getKeyring().activeKeyId, "utf8");
}

export function hashRefreshToken(token: string): string {
  return keyedDigest(token, pepper());
}

export async function signAccessToken(input: {
  sessionId: string;
  userId: string;
  email: string;
  role: "user" | "admin";
  amr: readonly PrimaryAuthMethod[];
  mfa: boolean;
  ttlSeconds: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + input.ttlSeconds) * 1000);
  const token = await new SignJWT({
    email: input.email,
    role: input.role,
    amr: [...input.amr],
    mfa: input.mfa,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(input.sessionId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(secretKey());
  return { token, expiresAt };
}

/**
 * Verify the signature, issuer, audience and expiry of an access token.
 * Returns `null` for anything that does not check out — callers must treat
 * `null` as "unauthenticated" and never as "authenticated with defaults".
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const sid = payload.jti;
    if (typeof sid !== "string" || typeof payload.sub !== "string") return null;
    if (typeof payload.email !== "string" || (payload.role !== "user" && payload.role !== "admin")) {
      return null;
    }
    const amr = Array.isArray(payload.amr)
      ? payload.amr.filter((v): v is string => typeof v === "string")
      : [];
    return {
      sid,
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      amr: amr.filter((v): v is PrimaryAuthMethod =>
        v === "password" || v === "github" || v === "email_otp",
      ),
      mfa: payload.mfa === true,
      iat: typeof payload.iat === "number" ? payload.iat : 0,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly authMethod: PrimaryAuthMethod;
  readonly status: "pending_mfa" | "active";
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  readonly ipHash?: string | null;
  readonly userAgentHash?: string | null;
}

/** Create a session row and issue its first token pair. */
export async function createSession(input: CreateSessionInput): Promise<IssuedTokens> {
  const db = getDb();
  const sessionId = randomUUID();
  const refreshToken = toBase64Url(randomBytesOf(32));
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + input.accessTtlSeconds * 1000);
  const refreshExpiresAt = new Date(now.getTime() + input.refreshTtlSeconds * 1000);

  await db.insert(sessions).values({
    id: sessionId,
    userId: input.userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    familyId: sessionId,
    status: input.status,
    authMethod: input.authMethod,
    mfaSatisfiedAt: input.status === "active" ? now : null,
    accessExpiresAt,
    refreshExpiresAt,
    lastRotatedAt: now,
    ipHash: input.ipHash ?? null,
    userAgentHash: input.userAgentHash ?? null,
  });

  const { token } = await signAccessToken({
    sessionId,
    userId: input.userId,
    email: input.email,
    role: input.role,
    amr: [input.authMethod],
    mfa: input.status === "active",
    ttlSeconds: input.accessTtlSeconds,
  });

  return { sessionId, accessToken: token, refreshToken, accessExpiresAt, refreshExpiresAt };
}

/** Minimal user lookup used only to stamp claims on a freshly issued token. */
async function loadIdentity(userId: string): Promise<{ email: string; role: "user" | "admin" } | null> {
  const db = getDb();
  const [row] = await db
    .select({ email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  return { email: row.email, role: row.role };
}

export async function findSessionById(sessionId: string): Promise<SessionRow | null> {
  const db = getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return row ?? null;
}

export async function findSessionByRefreshToken(refreshToken: string): Promise<SessionRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, hashRefreshToken(refreshToken)));
  return row ?? null;
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The presented token's hash is replaced immediately, so the same refresh
 * token cannot be used twice. Reuse of a rotated-out token is the classic
 * refresh-token-theft signal, so the whole rotation family is revoked.
 */
export async function rotateRefreshToken(
  session: SessionRow,
  refreshTtlSeconds: number,
): Promise<IssuedTokens | null> {
  const db = getDb();
  if (session.status === "revoked") return null;
  if (session.refreshExpiresAt.getTime() <= Date.now()) return null;

  const newRefreshToken = toBase64Url(randomBytesOf(32));
  const now = new Date();
  const refreshExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

  await db
    .update(sessions)
    .set({
      refreshTokenHash: hashRefreshToken(newRefreshToken),
      lastRotatedAt: now,
      refreshExpiresAt,
      accessExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    })
    .where(eq(sessions.id, session.id));

  const identity = await loadIdentity(session.userId);
  if (!identity) return null;

  const { token } = await signAccessToken({
    sessionId: session.id,
    userId: session.userId,
    email: identity.email,
    role: identity.role,
    amr: [session.authMethod as PrimaryAuthMethod],
    mfa: session.mfaSatisfiedAt !== null,
    ttlSeconds: 15 * 60,
  });

  return {
    sessionId: session.id,
    accessToken: token,
    refreshToken: newRefreshToken,
    accessExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    refreshExpiresAt,
  };
}

/**
 * Promote a `pending_mfa` session to `active` under a *new* session id.
 *
 * Rotating the identifier here is what makes pre-MFA tokens worthless: the old
 * row is revoked in the same transaction, so any cookie minted before the
 * second factor was satisfied stops resolving.
 */
export async function activateSessionAfterMfa(input: {
  readonly sessionId: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}): Promise<IssuedTokens | null> {
  const db = getDb();
  const existing = await findSessionById(input.sessionId);
  if (!existing || existing.status !== "pending_mfa") return null;
  if (existing.refreshExpiresAt.getTime() <= Date.now()) return null;

  const newSessionId = randomUUID();
  const refreshToken = toBase64Url(randomBytesOf(32));
  const now = new Date();

  await db
    .update(sessions)
    .set({ status: "revoked" })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.status, "pending_mfa")));

  await db.insert(sessions).values({
    id: newSessionId,
    userId: existing.userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    familyId: existing.familyId,
    status: "active",
    authMethod: existing.authMethod,
    mfaSatisfiedAt: now,
    accessExpiresAt: new Date(now.getTime() + input.accessTtlSeconds * 1000),
    refreshExpiresAt: new Date(now.getTime() + input.refreshTtlSeconds * 1000),
    lastRotatedAt: now,
    ipHash: existing.ipHash,
    userAgentHash: existing.userAgentHash,
  });

  const identity = await loadIdentity(existing.userId);
  if (!identity) return null;

  const { token } = await signAccessToken({
    sessionId: newSessionId,
    userId: existing.userId,
    email: identity.email,
    role: identity.role,
    amr: [existing.authMethod as PrimaryAuthMethod],
    mfa: true,
    ttlSeconds: input.accessTtlSeconds,
  });

  return {
    sessionId: newSessionId,
    accessToken: token,
    refreshToken,
    accessExpiresAt: new Date(now.getTime() + input.accessTtlSeconds * 1000),
    refreshExpiresAt: new Date(now.getTime() + input.refreshTtlSeconds * 1000),
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ status: "revoked" }).where(eq(sessions.id, sessionId));
}

/** Revoke every session of a user — used on password reset and on lockout. */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(sessions)
    .set({ status: "revoked" })
    .where(and(eq(sessions.userId, userId), eq(sessions.status, "active")))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Revoke an entire rotation family, e.g. on refresh-token reuse detection. */
export async function revokeSessionFamily(familyId: string): Promise<void> {
  const db = getDb();
  await db.update(sessions).set({ status: "revoked" }).where(eq(sessions.familyId, familyId));
}
