"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal/guards";
import { getInstanceSettings, updateInstanceSettings } from "@/lib/config/settings";
import { reEncryptAllCredentials } from "@/lib/dal/credentials";
import { buildRequestContext } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";
import { AUDIT_ACTIONS } from "@/lib/audit/events";
import { formDataToObject } from "@/lib/validation/schemas";
import { storageConfigPatchSchema } from "@/lib/storage/config";
import { updateStorageConfig } from "@/lib/dal/storage";
import type { AuthMethod } from "@/lib/config/schema";

/**
 * Instance administration actions.
 *
 * `requireAdmin()` is the authorisation boundary: it demands an authenticated
 * administrator whose second factor has been satisfied. Nothing below it
 * re-derives trust from the request.
 */

export interface AdminResult {
  readonly ok: boolean;
  readonly message: string;
}

function splitList(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function optionalSecret(value: FormDataEntryValue | null): string | undefined {
  // An untouched password field is left blank, which must mean "keep the stored
  // value" rather than "clear it".
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function saveInstanceSettings(formData: FormData): Promise<AdminResult> {
  const admin = await requireAdmin();
  const current = await getInstanceSettings();
  const raw = formDataToObject(formData);

  const authMethods = splitList(formData.get("authMethods") ?? null).filter(
    (method): method is AuthMethod =>
      method === "password" || method === "github" || method === "email_otp",
  );
  if (authMethods.length === 0) {
    return { ok: false, message: "At least one sign-in method must stay enabled." };
  }

  const patch: Parameters<typeof updateInstanceSettings>[0] = {
    authMethods,
    githubClientId: typeof raw.githubClientId === "string" ? raw.githubClientId : null,
    githubClientSecret: optionalSecret(formData.get("githubClientSecret") ?? null),
    githubAllowedUsers: splitList(formData.get("githubAllowedUsers") ?? null),
    githubAllowedOrgs: splitList(formData.get("githubAllowedOrgs") ?? null),
    resendApiKey: optionalSecret(formData.get("resendApiKey") ?? null),
    emailFrom: typeof raw.emailFrom === "string" && raw.emailFrom !== "" ? raw.emailFrom : null,
    registrationMode: parseEnum(raw.registrationMode, ["closed", "invite-only", "allowlist"], current.registrationMode) as
      | "closed"
      | "invite-only"
      | "allowlist"
      | undefined,
    totpPolicy: parseEnum(raw.totpPolicy, ["optional", "required", "admin-only"], current.totpPolicy) as
      | "optional"
      | "required"
      | "admin-only"
      | undefined,
    passwordMinLength: clampNumber(raw.passwordMinLength, 12, 128, current.passwordMinLength),
    passwordRequireComplexity: formData.get("passwordRequireComplexity") === "on",
    otpTtlSeconds: clampNumber(raw.otpTtlSeconds, 60, 3600, current.otpTtlSeconds),
    otpMaxAttempts: clampNumber(raw.otpMaxAttempts, 3, 10, current.otpMaxAttempts),
    otpResendCooldownSeconds: clampNumber(
      raw.otpResendCooldownSeconds,
      30,
      3600,
      current.otpResendCooldownSeconds,
    ),
    transitionsEnabled: formData.get("transitionsEnabled") === "on",
    respectReducedMotion: formData.get("respectReducedMotion") === "on",
    allowedMailOrigins: splitList(formData.get("allowedMailOrigins") ?? null).filter((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === "https:";
      } catch {
        // A non-URL entry would silently break the CSP; drop it instead.
        return false;
      }
    }),
  };

  try {
    await updateInstanceSettings(patch, admin.userId);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save those settings.",
    };
  }

  const ctx = buildRequestContext(await headers());
  // Never record which values changed, only that a change happened: the secrets
  // themselves must not reach the audit log.
  await writeAudit({
    action: AUDIT_ACTIONS.ADMIN_SETTINGS_UPDATED,
    result: "success",
    actorId: admin.userId,
    actorEmail: admin.email,
    actorRole: admin.role,
    resourceType: "instance",
    ipHash: ctx.ipHash,
    userAgentHash: ctx.userAgentHash,
    metadata: {
      changed: Object.keys(patch).filter((key) => key !== "githubClientSecret" && key !== "resendApiKey"),
      secretsUpdated: [
        patch.githubClientSecret !== undefined ? "githubClientSecret" : null,
        patch.resendApiKey !== undefined ? "resendApiKey" : null,
      ].filter((v): v is string => v !== null),
    },
  });

  revalidatePath("/admin/settings");
  return { ok: true, message: "Settings saved." };
}

export async function rotateCredentials(): Promise<AdminResult> {
  const admin = await requireAdmin();
  const result = await reEncryptAllCredentials(admin);
  revalidatePath("/admin/settings");
  return {
    ok: true,
    message: `Re-encrypted ${result.migrated} credential(s); ${result.alreadyCurrent} already current.`,
  };
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/**
 * Save the bucket configuration.
 *
 * `requireAdmin()` decides authorisation; this function only parses and forwards.
 * A blank secret field means "keep the stored value", which is why it is
 * filtered out rather than written as an empty string.
 */
export async function saveStorageConfig(formData: FormData): Promise<AdminResult> {
  const admin = await requireAdmin();

  const raw = formDataToObject(formData);
  const mb = Number(raw.maxUploadBytesMb);
  const parsed = storageConfigPatchSchema.safeParse({
    provider: raw.provider,
    enabled: formData.get("enabled") === "on",
    endpoint: providerIsS3(raw.provider) ? optionalText(raw.endpoint) : undefined,
    r2AccountId: providerIsS3(raw.provider) ? undefined : optionalText(raw.r2AccountId),
    region: optionalText(raw.region) ?? undefined,
    bucket: optionalText(raw.bucket),
    accessKeyId: optionalText(raw.accessKeyId),
    secretAccessKey: optionalText(raw.secretAccessKey),
    forcePathStyle: formData.get("forcePathStyle") === "on",
    maxUploadBytes: Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1048576) : undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the storage settings." };
  }

  const result = await updateStorageConfig(
    admin,
    parsed.data,
    buildRequestContext(await headers()),
  );

  revalidatePath("/admin/settings");
  return result.ok ? { ok: true, message: "Storage settings saved." } : { ok: false, message: result.reason };
}

function providerIsS3(value: unknown): boolean {
  return value === "s3";
}

/** An untouched field stays undefined so the stored value survives. */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
