"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePrincipal } from "@/lib/dal/guards";
import { getUserSettings, updateUserSettings } from "@/lib/dal/settings";
import {
  beginTotpEnrollment,
  disableTotp as disableTotpForUser,
  regenerateRecoveryCodes,
} from "@/lib/dal/totp";
import {
  decryptCredential,
  deleteCredential,
  saveCredential as saveCredentialForUser,
} from "@/lib/dal/credentials";
import { buildRequestContext } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import {
  formDataToObject,
  parseInput,
  totpDisableSchema,
  mailCredentialSchema,
} from "@/lib/validation/schemas";

/**
 * Settings Server Actions.
 *
 * Each one starts with `requirePrincipal()`, so authorisation is decided by the
 * DAL and never inferred from the page that rendered the form.
 */

export interface SettingsResult {
  readonly ok: boolean;
  readonly message: string;
  readonly secret?: string;
  readonly uri?: string;
  readonly recoveryCodes?: string[];
}

async function context() {
  return buildRequestContext(await headers());
}

export async function savePreferences(formData: FormData): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const parsed = (await import("@/lib/validation/schemas")).userSettingsSchema.safeParse({
    ...formDataToObject(formData),
    // Unchecked checkboxes are simply absent from FormData.
    blockRemoteImages: formData.get("blockRemoteImages") === "on",
    transitionsEnabled: formData.get("transitionsEnabled") === "on",
    messagesPerPage: Number(formData.get("messagesPerPage") ?? 25),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the values." };
  }

  await updateUserSettings(principal, parsed.data);
  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}

export async function beginEnrollment(): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const result = await beginTotpEnrollment(principal, await context());
  revalidatePath("/settings");
  return {
    ok: true,
    message: "Scan the secret with your authenticator.",
    secret: result.secret,
    uri: result.uri,
    recoveryCodes: [...result.recoveryCodes],
  };
}

export async function disableTotp(formData: FormData): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const parsed = parseInput(totpDisableSchema, formDataToObject(formData));
  if (!parsed.ok) {
    return { ok: false, message: "Enter your current code or a recovery code." };
  }

  const result = await disableTotpForUser(principal, parsed.value, await context());
  revalidatePath("/settings");
  return result.ok
    ? { ok: true, message: "Two-factor authentication is now off." }
    : { ok: false, message: result.reason };
}

export async function regenerateCodes(): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const codes = await regenerateRecoveryCodes(principal, await context());
  revalidatePath("/settings");
  return { ok: true, message: "New recovery codes generated.", recoveryCodes: [...codes] };
}

export async function saveCredential(formData: FormData): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const raw = {
    ...formDataToObject(formData),
    port: formData.get("port") ? Number(formData.get("port")) : undefined,
  };

  const parsed = parseInput(mailCredentialSchema, raw);
  if (!parsed.ok) {
    return { ok: false, message: parsed.issues[0] ?? "Check the account details." };
  }

  const value = parsed.value;
  const ctx = await context();

  await saveCredentialForUser({
    principal,
    label: value.label,
    protocol: value.protocol,
    endpoint: value.endpoint,
    port: value.protocol === "imap" ? (value.port ?? 993) : null,
    username: value.username,
    kind: value.protocol === "jmap" ? "jmap_token" : "imap_password",
    secret: value.protocol === "jmap" ? value.token : value.password,
    context: ctx,
  });

  revalidatePath("/settings");
  return { ok: true, message: "Account saved." };
}

export async function removeCredential(credentialId: string): Promise<SettingsResult> {
  const principal = await requirePrincipal();
  const removed = await deleteCredential(principal, credentialId, await context());
  revalidatePath("/settings");
  return removed
    ? { ok: true, message: "Account removed." }
    : { ok: false, message: "That account could not be removed." };
}

/**
 * Demonstrates the audited decryption path.
 *
 * The plaintext exists only for the lifetime of this call and is never written
 * anywhere; the audit record captures who, when and why.
 */
export async function useCredential(
  credentialId: string,
  purpose: "imap-connect" | "smtp-connect" | "jmap-session" | "rotation",
): Promise<{ ok: boolean; message: string }> {
  const principal = await requirePrincipal();
  const ctx = await context();

  try {
    const credential = await decryptCredential({ principal, credentialId, purpose, context: ctx });
    void credential.secret;
    return { ok: true, message: "Credential decrypted in memory." };
  } catch {
    await writeAudit({
      action: AUDIT_ACTIONS.CREDENTIAL_DECRYPT_FAILED,
      result: "error",
      actorId: principal.userId,
      actorEmail: principal.email,
      resourceType: "credential",
      resourceId: credentialId,
      ipHash: ctx.ipHash,
      userAgentHash: ctx.userAgentHash,
      metadata: { purpose, reason: "denied" },
    });
    return { ok: false, message: "That credential is not available." };
  }
}

export { getUserSettings };
