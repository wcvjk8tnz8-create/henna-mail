import { writeAudit, queryAuditLog, type AuditPage, type AuditQuery } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { requireAdmin } from "./guards";
import type { Principal } from "./types";

/**
 * Audit log access.
 *
 * Reading the audit log is itself an auditable administrative action, and
 * exporting it is recorded too. There is no delete or update path anywhere in
 * Henna: the log is append-only, and the application's database role should be
 * granted INSERT and SELECT only (see db/migrations/0000_init.sql).
 */

export async function readAuditLog(query: AuditQuery): Promise<AuditPage> {
  // The guard is the authorisation boundary; nothing below re-checks.
  await requireAdmin();
  return queryAuditLog(query);
}

/** The current user's own security history — no administrator role needed. */
export async function readOwnAuditLog(
  principal: Principal,
  query: Omit<AuditQuery, "actorId"> = {},
): Promise<AuditPage> {
  return queryAuditLog({ ...query, actorId: principal.userId });
}

export async function exportAuditLog(query: AuditQuery): Promise<string> {
  const actor = await requireAdmin();
  const page = await queryAuditLog({ ...query, limit: 500 });

  await writeAudit({
    action: AUDIT_ACTIONS.ADMIN_AUDIT_EXPORTED,
    result: "success",
    actorId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: "audit",
    metadata: { rows: page.rows.length, filters: { ...query } },
  });

  const header = [
    "timestamp",
    "actor_id",
    "actor_email",
    "action",
    "resource_type",
    "resource_id",
    "result",
    "ip_hash",
  ];
  const lines = page.rows.map((row) =>
    [
      row.timestamp.toISOString(),
      row.actorId ?? "",
      row.actorEmail ?? "",
      row.action,
      row.resourceType,
      row.resourceId ?? "",
      row.result,
      row.ipHash ?? "",
    ]
      .map((field) => `"${String(field).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
