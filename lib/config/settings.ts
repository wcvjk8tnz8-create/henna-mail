import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { instanceSettings as instanceSettingsTable } from "@/db/schema";
import { getKeyring } from "@/lib/crypto/keyring";
import { rawEnv } from "./env";
import {
  DEFAULT_INSTANCE_SETTINGS,
  instanceSettingsSchema,
  type InstanceSettings,
  type UpdateSettingsInput,
} from "./schema";

/**
 * Instance configuration layer.
 *
 * Root settings (DOMAIN, ADMIN, jwt_secret, HENNA_CREDENTIAL_KEY) come from the
 * environment and cannot be changed here. Everything else is stored in
 * PostgreSQL and editable by an administrator at /admin/settings, so that
 * rotating a Resend key or changing the TOTP policy does not require a
 * redeploy.
 *
 * Secrets written through this layer are AES-256-GCM encrypted in dedicated
 * columns. They are never returned in the JSON `payload` blob, and they are
 * only returned in plaintext to server-side callers that need to use them.
 */

const CACHE_TTL_MS = 30_000;

let cache: { value: InstanceSettings; expiresAt: number } | null = null;

export function resetSettingsCache(): void {
  cache = null;
}

/**
 * Environment fallbacks for deployments that prefer wrangler secrets over
 * the admin UI. The admin UI always wins once a row exists.
 */
function envFallbacks(): Partial<InstanceSettings> {
  const env = rawEnv();
  const result: Partial<InstanceSettings> = {};
  if (env.GITHUB_CLIENT_ID) result.githubClientId = env.GITHUB_CLIENT_ID;
  if (env.HENNA_EMAIL_FROM) result.emailFrom = env.HENNA_EMAIL_FROM;
  if (env.HENNA_REGISTRATION_MODE) result.registrationMode = env.HENNA_REGISTRATION_MODE as never;
  if (env.HENNA_TOTP_POLICY) result.totpPolicy = env.HENNA_TOTP_POLICY as never;
  if (env.HENNA_ALLOWED_GITHUB_USERS) {
    result.githubAllowedUsers = env.HENNA_ALLOWED_GITHUB_USERS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (env.HENNA_ALLOWED_GITHUB_ORGS) {
    result.githubAllowedOrgs = env.HENNA_ALLOWED_GITHUB_ORGS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return result;
}

/** Read the effective instance settings (environment fallbacks merged in). */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  if (cache !== null && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  const db = getDb();
  const [row] = await db.select().from(instanceSettingsTable).where(eq(instanceSettingsTable.id, 1));

  const parsed = instanceSettingsSchema.safeParse({
    ...DEFAULT_INSTANCE_SETTINGS,
    ...envFallbacks(),
    ...parsePayload(row?.payload),
  });

  const value = parsed.success ? parsed.data : DEFAULT_INSTANCE_SETTINGS;
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export interface InstanceSecrets {
  readonly githubClientSecret: string | null;
  readonly resendApiKey: string | null;
}

/**
 * Decrypt the administrator-managed secrets.
 *
 * Every successful read here is an auditable event: callers must record a
 * `secret.decrypt` audit entry (see lib/dal/settings.ts).
 */
export async function getInstanceSecrets(): Promise<InstanceSecrets> {
  const db = getDb();
  const [row] = await db.select().from(instanceSettingsTable).where(eq(instanceSettingsTable.id, 1));
  if (!row) {
    const env = rawEnv();
    return {
      githubClientSecret: env.GITHUB_CLIENT_SECRET ?? null,
      resendApiKey: env.RESEND_API_KEY ?? null,
    };
  }

  const keyring = getKeyring();
  const githubClientSecret = row.githubClientSecretEnc
    ? keyring.decrypt(row.githubClientSecretEnc, "github_client_secret")
    : null;
  const resendApiKey = row.resendApiKeyEnc
    ? keyring.decrypt(row.resendApiKeyEnc, "resend_api_key")
    : null;
  return { githubClientSecret, resendApiKey };
}

/** Settings that are safe to send to the browser (no secrets, ever). */
export interface PublicInstanceSettings {
  readonly authMethods: readonly string[];
  readonly registrationMode: string;
  readonly totpPolicy: string;
  readonly passwordMinLength: number;
  readonly passwordRequireComplexity: boolean;
  readonly otpTtlSeconds: number;
  readonly otpResendCooldownSeconds: number;
  readonly transitionsEnabled: boolean;
  readonly respectReducedMotion: boolean;
  readonly githubConfigured: boolean;
  readonly resendConfigured: boolean;
  readonly mailDomains: readonly string[];
}

export async function getPublicInstanceSettings(
  mailDomains: readonly string[],
): Promise<PublicInstanceSettings> {
  const [settings, secrets] = await Promise.all([getInstanceSettings(), getInstanceSecrets()]);
  return {
    authMethods: settings.authMethods,
    registrationMode: settings.registrationMode,
    totpPolicy: settings.totpPolicy,
    passwordMinLength: settings.passwordMinLength,
    passwordRequireComplexity: settings.passwordRequireComplexity,
    otpTtlSeconds: settings.otpTtlSeconds,
    otpResendCooldownSeconds: settings.otpResendCooldownSeconds,
    transitionsEnabled: settings.transitionsEnabled,
    respectReducedMotion: settings.respectReducedMotion,
    githubConfigured: Boolean(settings.githubClientId && secrets.githubClientSecret),
    resendConfigured: Boolean(secrets.resendApiKey && settings.emailFrom),
    mailDomains,
  };
}

/**
 * Persist an administrator's changes.
 *
 * The `payload` column only ever receives non-secret values; secrets are split
 * out, encrypted with the active credential key, and stored in their own
 * columns so that a settings export cannot leak them.
 */
export async function updateInstanceSettings(
  input: UpdateSettingsInput,
  actorId: string | null,
): Promise<InstanceSettings> {
  const current = await getInstanceSettings();
  const merged = { ...current, ...input };
  const parsed = instanceSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new SettingsValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const next = parsed.data;

  const keyring = getKeyring();
  const secretPatch: Partial<typeof instanceSettingsTable.$inferInsert> = {};

  if (input.githubClientSecret !== undefined) {
    if (input.githubClientSecret === null) {
      secretPatch.githubClientSecretEnc = null;
      secretPatch.githubClientSecretKeyId = null;
    } else {
      secretPatch.githubClientSecretEnc = keyring.encrypt(
        input.githubClientSecret,
        "github_client_secret",
      );
      secretPatch.githubClientSecretKeyId = keyring.activeKeyId;
    }
  }
  if (input.resendApiKey !== undefined) {
    if (input.resendApiKey === null) {
      secretPatch.resendApiKeyEnc = null;
      secretPatch.resendApiKeyKeyId = null;
    } else {
      secretPatch.resendApiKeyEnc = keyring.encrypt(input.resendApiKey, "resend_api_key");
      secretPatch.resendApiKeyKeyId = keyring.activeKeyId;
    }
  }

  // Strip secrets out of the JSON payload before it is written.
  const payload: Record<string, unknown> = { ...next };
  delete payload.githubClientSecret;
  delete payload.resendApiKey;

  const db = getDb();
  await db
    .insert(instanceSettingsTable)
    .values({
      id: 1,
      payload: JSON.stringify(payload),
      updatedBy: actorId ?? undefined,
      updatedAt: new Date(),
      ...secretPatch,
    })
    .onConflictDoUpdate({
      target: instanceSettingsTable.id,
      set: {
        payload: JSON.stringify(payload),
        updatedBy: actorId ?? undefined,
        updatedAt: new Date(),
        ...(Object.keys(secretPatch).length > 0 ? secretPatch : {}),
      },
    });

  resetSettingsCache();
  return next;
}

export class SettingsValidationError extends Error {
  override readonly name = "SettingsValidationError";
}

/** Key IDs currently used by stored secrets — drives the rotation UI. */
export async function getSecretKeyIds(): Promise<{
  githubClientSecretKeyId: string | null;
  resendApiKeyKeyId: string | null;
}> {
  const db = getDb();
  const [row] = await db.select().from(instanceSettingsTable).where(eq(instanceSettingsTable.id, 1));
  return {
    githubClientSecretKeyId: row?.githubClientSecretKeyId ?? null,
    resendApiKeyKeyId: row?.resendApiKeyKeyId ?? null,
  };
}

/**
 * Decode the settings payload.
 *
 * Stored as JSON text on both PostgreSQL and D1, so the encode/decode is
 * explicit rather than relying on a `jsonb` column. A corrupt or hand-edited
 * value degrades to "no overrides" instead of throwing during boot.
 */
function parsePayload(raw: string | null | undefined): Partial<InstanceSettings> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Partial<InstanceSettings>;
  } catch {
    return {};
  }
}

export type { InstanceSettings, UpdateSettingsInput } from "./schema";
