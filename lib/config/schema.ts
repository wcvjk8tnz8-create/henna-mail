import { z } from "zod";

/**
 * Zod schemas for the two configuration layers:
 *
 *  1. Root configuration — environment variables only, never editable in the
 *     UI (see docs/self-hosting.md).
 *  2. Instance configuration — stored in PostgreSQL, editable by admins at
 *     /admin/settings. Secrets in this layer are AES-256-GCM encrypted at rest.
 *
 * Nothing here uses `any`. Every exported type is inferred from a schema.
 */

/* ------------------------------------------------------------------ */
/* Root configuration (environment)                                    */
/* ------------------------------------------------------------------ */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid email address");

/**
 * `DOMAIN` is provided as a JSON array, e.g. `["example.com","example2.com"]`.
 */
export const domainListSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: "custom", message: "DOMAIN must be a JSON array of domains" });
        return z.NEVER;
      }
      return parsed as string[];
    } catch {
      ctx.addIssue({
        code: "custom",
        message: 'DOMAIN must be valid JSON, e.g. ["example.com","example2.com"]',
      });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .min(4)
          .max(253)
          .regex(
            /^(?!-)[a-z0-9-]+((\.[a-z0-9-]+)+)?$/i,
            "Each DOMAIN entry must be a bare domain such as example.com",
          ),
      )
      .min(1, "DOMAIN must contain at least one domain"),
  );

/**
 * Session/JWT signing secret.
 *
 * Any non-empty string of letters and digits. There is deliberately no length
 * minimum: `jwt_secret` is also the seed the credential key is derived from, so
 * a short value *is* weaker, but refusing to boot over it turns a
 * "paste anything and click Deploy" flow into a support question. The
 * documentation tells people to use `openssl rand -hex 24`; the code does not
 * enforce it.
 *
 * "no special characters" is a real constraint, not a stylistic one: the value
 * travels through CI secret stores, shell scripts and wrangler secret files
 * where punctuation needs quoting, and a mis-quoted secret produces a
 * confusing auth failure rather than an obvious error.
 */
export const jwtSecretSchema = z
  .string()
  .min(1, "jwt_secret must not be empty")
  .max(512)
  .regex(/^[A-Za-z0-9]+$/, "jwt_secret must contain only letters and digits (no special characters)");

export const registrationModeSchema = z.enum(["closed", "invite-only", "allowlist"]);
export const totpPolicySchema = z.enum(["optional", "required", "admin-only"]);
export const authMethodSchema = z.enum(["password", "github", "email_otp"]);

export const rootEnvSchema = z.object({
  /** Mail domains this instance serves. JSON array. Root config. */
  DOMAIN: domainListSchema,
  /** Bootstrap administrator email address. Root config. */
  ADMIN: emailSchema,
  /** Session/JWT signing secret. Root config. */
  jwt_secret: jwtSecretSchema,

  /**
   * AES-256-GCM keyring, comma separated base64 32-byte keys.
   *
   * Optional so that a deployment can boot from the three root variables alone
   * (DOMAIN, ADMIN, jwt_secret). When absent, a key is derived from
   * `jwt_secret` by HKDF — see lib/crypto/keyring.ts for why that is safe and
   * what it costs.
   */
  HENNA_CREDENTIAL_KEY: z.string().min(1).optional(),

  /** Node.js / self-hosted only. On Workers, Hyperdrive is used instead. */
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(16).optional(),

  /** Optional fallbacks; the admin UI is the preferred place to set these. */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  HENNA_EMAIL_FROM: emailSchema.optional(),

  HENNA_REGISTRATION_MODE: registrationModeSchema.optional(),
  HENNA_TOTP_POLICY: totpPolicySchema.optional(),
  HENNA_ALLOWED_GITHUB_USERS: z.string().optional(),
  HENNA_ALLOWED_GITHUB_ORGS: z.string().optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});

export type RootEnv = z.infer<typeof rootEnvSchema>;
export type RegistrationMode = z.infer<typeof registrationModeSchema>;
export type TotpPolicy = z.infer<typeof totpPolicySchema>;
export type AuthMethod = z.infer<typeof authMethodSchema>;

/* ------------------------------------------------------------------ */
/* Instance configuration (database-backed, admin editable)            */
/* ------------------------------------------------------------------ */

export const instanceSettingsSchema = z.object({
  authMethods: z
    .array(authMethodSchema)
    .min(1, "At least one authentication method must remain enabled")
    .default(["password"]),

  githubClientId: z.string().max(256).nullable().default(null),
  githubClientSecret: z.string().max(256).nullable().default(null),
  githubAllowedUsers: z.array(z.string().max(64)).default([]),
  githubAllowedOrgs: z.array(z.string().max(64)).default([]),

  resendApiKey: z.string().max(256).nullable().default(null),
  emailFrom: emailSchema.nullable().default(null),

  registrationMode: registrationModeSchema.default("closed"),
  totpPolicy: totpPolicySchema.default("admin-only"),

  passwordMinLength: z.number().int().min(12).max(128).default(12),
  passwordRequireComplexity: z.boolean().default(false),

  otpTtlSeconds: z.number().int().min(60).max(3600).default(600),
  otpMaxAttempts: z.number().int().min(3).max(10).default(5),
  otpResendCooldownSeconds: z.number().int().min(30).max(3600).default(60),

  sessionTtlSeconds: z.number().int().min(60).max(900).default(900),
  refreshTtlSeconds: z.number().int().min(900).max(2592000).default(2592000),

  /** Page transition preferences (see docs/architecture.md). */
  transitionsEnabled: z.boolean().default(true),
  respectReducedMotion: z.boolean().default(true),

  /** Allowed upstream mail origins for CSP frame-src/connect-src. */
  allowedMailOrigins: z.array(z.string().max(253)).default([]),
});

export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

/** Default instance settings, used before the admin has saved anything. */
export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = instanceSettingsSchema.parse({});

export const updateSettingsSchema = instanceSettingsSchema.partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
