import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { AUDIT_ACTIONS, type AuditEvent } from "./events";

/**
 * Append-only audit writer.
 *
 * The audit log is the tamper-evidence layer for Henna: every authentication
 * decision, every credential decryption and every administrative action lands
 * here. There is deliberately no update or delete path in application code —
 * the database role used by the app is granted INSERT and SELECT on
 * `audit_log` only (see db/migrations/0000_init.sql).
 */

const FORBIDDEN_METADATA_KEYS: readonly string[] = [
  "password",
  "newpassword",
  "currentpassword",
  "code",
  "otp",
  "otpcode",
  "token",
  "secret",
  "secretencc",
  "clientsecret",
  "apikey",
  "credential",
  "refreshtoken",
  "sessiontoken",
  "recoverycode",
];

export class AuditError extends Error {
  override readonly name = "AuditError";
}

/** JSON text, or null. Never throws: a bad context must not lose the event. */
function serializeMetadata(metadata: Record<string, unknown> | null): string | null {
  if (metadata === null) return null;
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
}

function scrub(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.includes(key.toLowerCase())) {
      // Never drop the fact that a value was present, only the value itself.
      cleaned[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 512) {
      cleaned[key] = `${value.slice(0, 512)}…`;
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Write one audit event.
 *
 * A failure to write an audit record is treated as fatal for the request: an
 * action that cannot be audited must not proceed. Callers therefore `await`
 * this and let the error propagate.
 */
export async function writeAudit(event: AuditEvent): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    action: event.action,
    result: event.result,
    actorId: event.actorId ?? null,
    actorEmail: event.actorEmail ?? null,
    actorRole: event.actorRole ?? null,
    resourceType: event.resourceType ?? "system",
    resourceId: event.resourceId ?? null,
    ipHash: event.ipHash ?? null,
    userAgentHash: event.userAgentHash ?? null,
    // JSON text on both dialects; see the note in db/schema.pg.ts.
    metadata: serializeMetadata(scrub(event.metadata)),
  });
}

export interface AuditQuery {
  readonly actorId?: string;
  readonly action?: string;
  readonly result?: "success" | "denied" | "error";
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditPage {
  readonly rows: readonly {
    id: string;
    timestamp: Date;
    actorId: string | null;
    actorEmail: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    result: string;
    ipHash: string | null;
    userAgentHash: string | null;
    metadata: Record<string, unknown> | null;
  }[];
  readonly total: number;
}

/**
 * Read the audit log. Only reachable through `lib/dal/audit.ts`, which applies
 * the administrator authorisation check first.
 */
export async function queryAuditLog(query: AuditQuery): Promise<AuditPage> {
  const db = getDb();
  const { and, count, desc, gte, lte, eq, sql } = await import("drizzle-orm");

  const filters = [];
  if (query.actorId) filters.push(eq(auditLog.actorId, query.actorId));
  if (query.action) filters.push(eq(auditLog.action, query.action));
  if (query.result) filters.push(eq(auditLog.result, query.result));
  if (query.from) filters.push(gte(auditLog.timestamp, query.from));
  if (query.to) filters.push(lte(auditLog.timestamp, query.to));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.timestamp))
      .limit(limit)
      .offset(offset),
    db.select({ value: count(sql`*`) }).from(auditLog).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      result: row.result,
      ipHash: row.ipHash,
      userAgentHash: row.userAgentHash,
      metadata: parseMetadata(row.metadata),
    })),
    total: Number(totals[0]?.value ?? 0),
  };
}

export { AUDIT_ACTIONS };
export type { AuditAction, AuditEvent, AuditResult } from "./events";

/** Decode the metadata column. A corrupt value yields null, never a throw. */
function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
