import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rateLimitCounters } from "@/db/schema";

/**
 * Rate limiting.
 *
 * Counters live in PostgreSQL, not in memory: a Cloudflare Workers deployment
 * runs many isolates concurrently and an in-isolate counter would be trivially
 * bypassed by spreading attempts across isolates. A single atomic upsert does
 * the read-modify-write, so concurrent requests cannot race past the limit.
 */

export interface RateLimitRule {
  /** Stable scope name, e.g. `login`, `totp`, `otp_send`. */
  readonly scope: string;
  /** Maximum number of attempts inside one window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** How long a tripped limit stays tripped. */
  readonly blockSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly reason: "ok" | "blocked" | "throttled";
}

export const RATE_LIMIT_RULES = {
  /** Per IP across all accounts. */
  loginByIp: { scope: "login:ip", limit: 10, windowSeconds: 900, blockSeconds: 900 },
  /** Per account, regardless of source IP. */
  loginByEmail: { scope: "login:email", limit: 5, windowSeconds: 900, blockSeconds: 900 },
  githubCallbackByIp: {
    scope: "github-callback:ip",
    limit: 20,
    windowSeconds: 900,
    blockSeconds: 900,
  },
  otpSendByEmail: { scope: "otp-send:email", limit: 3, windowSeconds: 3600, blockSeconds: 3600 },
  otpSendByIp: { scope: "otp-send:ip", limit: 10, windowSeconds: 3600, blockSeconds: 3600 },
  otpVerify: { scope: "otp-verify", limit: 10, windowSeconds: 900, blockSeconds: 900 },
  totpVerify: { scope: "totp-verify", limit: 5, windowSeconds: 900, blockSeconds: 900 },
  passwordReset: { scope: "password-reset", limit: 3, windowSeconds: 3600, blockSeconds: 3600 },
  credentialDecrypt: {
    scope: "credential-decrypt",
    limit: 60,
    windowSeconds: 900,
    blockSeconds: 300,
  },
  /** Presigned URL issuance: cheap to sign, but not free to hand out. */
  storageUrl: { scope: "storage-url", limit: 120, windowSeconds: 900, blockSeconds: 300 },
} as const satisfies Record<string, RateLimitRule>;

export function rateLimitKey(rule: RateLimitRule, subject: string): string {
  return `${rule.scope}:${subject}`;
}

/**
 * Atomically consume one attempt.
 *
 * Returns `allowed: false` with a `retryAfterSeconds` when the subject is
 * inside a blocked window or has already used up the current window.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  const key = rateLimitKey(rule, subject);
  const db = getDb();

  const rows = await db.execute<{ count: number; blocked_until: Date | null }>(sql`
    INSERT INTO ${rateLimitCounters} (key, window_started_at, count, updated_at)
    VALUES (${key}, now(), 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN ${rateLimitCounters}.window_started_at < now() - (${rule.windowSeconds} * interval '1 second')
          THEN 1
        ELSE ${rateLimitCounters}.count + 1
      END,
      window_started_at = CASE
        WHEN ${rateLimitCounters}.window_started_at < now() - (${rule.windowSeconds} * interval '1 second')
          THEN now()
        ELSE ${rateLimitCounters}.window_started_at
      END,
      updated_at = now()
    RETURNING count, blocked_until
  `);

  const row = rows.rows[0];
  const count = Number(row?.count ?? 1);
  const blockedUntil = row?.blocked_until ? new Date(row.blocked_until) : null;

  if (blockedUntil && blockedUntil.getTime() > Date.now()) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 1000)),
      reason: "blocked",
    };
  }

  if (count > rule.limit) {
    await db.execute(sql`
      UPDATE ${rateLimitCounters}
      SET blocked_until = now() + (${rule.blockSeconds} * interval '1 second'), updated_at = now()
      WHERE key = ${key}
    `);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: rule.blockSeconds,
      reason: "throttled",
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: 0,
    reason: "ok",
  };
}

/** Clear a subject's counters — used after a successful authentication. */
export async function resetRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`DELETE FROM ${rateLimitCounters} WHERE key = ${rateLimitKey(rule, subject)}`);
}

/** Read-only peek for the login UI and for tests. */
export async function peekRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  const db = getDb();
  const rows = await db.execute<{ count: number; blocked_until: Date | null }>(sql`
    SELECT count, blocked_until FROM ${rateLimitCounters} WHERE key = ${rateLimitKey(rule, subject)}
  `);
  const row = rows.rows[0];
  if (!row) {
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, reason: "ok" };
  }
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until) : null;
  if (blockedUntil && blockedUntil.getTime() > Date.now()) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((blockedUntil.getTime() - Date.now()) / 1000),
      reason: "blocked",
    };
  }
  return {
    allowed: Number(row.count) <= rule.limit,
    remaining: Math.max(0, rule.limit - Number(row.count)),
    retryAfterSeconds: 0,
    reason: Number(row.count) > rule.limit ? "throttled" : "ok",
  };
}
