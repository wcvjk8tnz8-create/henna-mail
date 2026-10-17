import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailCredentials } from "@/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { getKeyring } from "@/lib/crypto/keyring";
import { consumeRateLimit, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import type { RequestContext } from "@/lib/request";
import { AuthzError } from "./types";
import type { Principal } from "./types";

/**
 * Upstream mail credentials.
 *
 * The hard rule: this module stores and decrypts credentials — it never fetches
 * mail. Decryption is rate limited and always audited with the actor, the
 * timestamp and the purpose; the plaintext is returned to the caller and never
 * written anywhere else.
 */

export interface CredentialDto {
  readonly id: string;
  readonly label: string;
  readonly protocol: "jmap" | "imap";
  readonly endpoint: string;
  readonly port: number | null;
  readonly username: string;
  readonly kind: string;
  readonly keyId: string;
  readonly createdAt: Date;
}

function toDto(row: typeof mailCredentials.$inferSelect): CredentialDto {
  return {
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    endpoint: row.endpoint,
    port: row.port,
    username: row.username,
    kind: row.kind,
    keyId: row.keyId,
    createdAt: row.createdAt,
  };
}

/** List the caller's own credentials, without any secret material. */
export async function listCredentials(principal: Principal): Promise<readonly CredentialDto[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(mailCredentials)
    .where(eq(mailCredentials.userId, principal.userId));
  return rows.map(toDto);
}

/**
 * Read one credential, enforcing ownership.
 *
 * Administrators are deliberately *not* granted access here: an administrator
 * who could list everyone's upstream credentials could read everyone's mail.
 */
export async function getCredential(
  principal: Principal,
  credentialId: string,
): Promise<CredentialDto | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(mailCredentials)
    .where(eq(mailCredentials.id, credentialId));

  if (!row) return null;
  if (row.userId !== principal.userId) {
    await writeAudit({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      actorRole: principal.role,
      resourceType: "credential",
      resourceId: credentialId,
      metadata: { reason: "not-owner" },
    });
    throw new AuthzError("forbidden", "You may only access your own credentials");
  }
  return toDto(row);
}

export type DecryptPurpose = "imap-connect" | "smtp-connect" | "jmap-session" | "rotation";

export interface DecryptedCredential {
  readonly id: string;
  readonly protocol: "jmap" | "imap";
  readonly endpoint: string;
  readonly port: number | null;
  readonly username: string;
  readonly secret: string;
  readonly kind: string;
}

/**
 * Decrypt a credential for immediate use.
 *
 * Every call is rate limited per user and written to the audit log. A payload
 * that fails authentication is an event worth investigating, so it is recorded
 * as `credential.decrypt_failed` rather than swallowed.
 */
export async function decryptCredential(input: {
  readonly principal: Principal;
  readonly credentialId: string;
  readonly purpose: DecryptPurpose;
  readonly context: RequestContext;
}): Promise<DecryptedCredential> {
  const { principal, credentialId, purpose, context } = input;
  const db = getDb();

  const limit = await consumeRateLimit(RATE_LIMIT_RULES.credentialDecrypt, principal.userId);
  if (!limit.allowed) {
    await writeAudit({
      action: AUDIT_ACTIONS.CREDENTIAL_DECRYPT_FAILED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "credential",
      resourceId: credentialId,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { purpose, reason: "rate-limited" },
    });
    throw new AuthzError("forbidden", "Too many credential operations; slow down");
  }

  const [row] = await db
    .select()
    .from(mailCredentials)
    .where(and(eq(mailCredentials.id, credentialId), eq(mailCredentials.userId, principal.userId)));

  if (!row) {
    await writeAudit({
      action: AUDIT_ACTIONS.CREDENTIAL_DECRYPT_FAILED,
      result: "denied",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "credential",
      resourceId: credentialId,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { purpose, reason: "not-found-or-not-owner" },
    });
    throw new AuthzError("forbidden", "Credential not available");
  }

  let secret: string;
  try {
    secret = getKeyring().decrypt(row.secretEnc, row.id);
  } catch {
    await writeAudit({
      action: AUDIT_ACTIONS.CREDENTIAL_DECRYPT_FAILED,
      result: "error",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "credential",
      resourceId: credentialId,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
      metadata: { purpose, reason: "authentication-failed" },
    });
    throw new AuthzError("forbidden", "Stored credential failed authentication");
  }

  await db
    .update(mailCredentials)
    .set({ lastDecryptedAt: new Date() })
    .where(eq(mailCredentials.id, credentialId));

  // Audited on every success: who, when, why. Never the value itself.
  await writeAudit({
    action: AUDIT_ACTIONS.CREDENTIAL_DECRYPTED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    actorRole: principal.role,
    resourceType: "credential",
    resourceId: credentialId,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    metadata: { purpose, protocol: row.protocol, keyId: row.keyId },
  });

  return {
    id: row.id,
    protocol: row.protocol,
    endpoint: row.endpoint,
    port: row.port,
    username: row.username,
    kind: row.kind,
    secret,
  };
}

export async function saveCredential(input: {
  readonly principal: Principal;
  readonly label: string;
  readonly protocol: "jmap" | "imap";
  readonly endpoint: string;
  readonly port: number | null;
  readonly username: string;
  readonly kind: "jmap_token" | "imap_password" | "smtp_password";
  readonly secret: string;
  readonly context: RequestContext;
}): Promise<CredentialDto> {
  const db = getDb();
  const keyring = getKeyring();
  const secretEnc = keyring.encrypt(input.secret, "");

  const [row] = await db
    .insert(mailCredentials)
    .values({
      userId: input.principal.userId,
      label: input.label,
      protocol: input.protocol,
      endpoint: input.endpoint,
      port: input.port,
      username: input.username,
      kind: input.kind,
      secretEnc,
      keyId: keyring.activeKeyId,
    })
    .returning();

  if (!row) throw new Error("Failed to save credential");

  await writeAudit({
    action: AUDIT_ACTIONS.CREDENTIAL_CREATED,
    result: "success",
    actorId: input.principal.userId,
    actorEmail: input.principal.email,
    resourceType: "credential",
    resourceId: row.id,
    ipHash: input.context.ipHash,
    userAgentHash: input.context.userAgentHash,
    metadata: { protocol: row.protocol, kind: row.kind, keyId: row.keyId },
  });

  return toDto(row);
}

export async function deleteCredential(
  principal: Principal,
  credentialId: string,
  context: RequestContext,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(mailCredentials)
    .where(and(eq(mailCredentials.id, credentialId), eq(mailCredentials.userId, principal.userId)))
    .returning({ id: mailCredentials.id });

  if (rows.length === 0) return false;

  await writeAudit({
    action: AUDIT_ACTIONS.CREDENTIAL_DELETED,
    result: "success",
    actorId: principal.userId,
    actorEmail: principal.email,
    resourceType: "credential",
    resourceId: credentialId,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  });
  return true;
}

/**
 * Re-encrypt every credential under the active key.
 *
 * Used by the rotation procedure: after a new key is prepended to
 * HENNA_CREDENTIAL_KEY, this walks the table and rewrites each row, so the
 * retired key can eventually be removed.
 */
export async function reEncryptAllCredentials(
  actor: Principal,
): Promise<{ migrated: number; alreadyCurrent: number }> {
  const db = getDb();
  const keyring = getKeyring();
  const rows = await db.select().from(mailCredentials);

  let migrated = 0;
  let alreadyCurrent = 0;

  for (const row of rows) {
    if (row.keyId === keyring.activeKeyId) {
      alreadyCurrent += 1;
      continue;
    }
    const plaintext = keyring.decrypt(row.secretEnc, row.id);
    await db
      .update(mailCredentials)
      .set({ secretEnc: keyring.encrypt(plaintext, row.id), keyId: keyring.activeKeyId })
      .where(eq(mailCredentials.id, row.id));
    migrated += 1;
  }

  await writeAudit({
    action: AUDIT_ACTIONS.KEY_ROTATION,
    result: "success",
    actorId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: "crypto",
    metadata: { scope: "mail_credentials", migrated, alreadyCurrent, keyId: keyring.activeKeyId },
  });

  return { migrated, alreadyCurrent };
}
