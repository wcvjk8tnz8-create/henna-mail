import { randomUUID } from "node:crypto";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

/**
 * Henna's D1 (SQLite) schema — the Cloudflare-native path.
 *
 * This mirrors `schema.pg.ts` table for table and column for column, so every
 * query in `lib/dal/` works unchanged on either dialect. The differences are
 * only those SQLite forces:
 *
 *  - UUIDs are `text` with a JS-side default; SQLite has no `gen_random_uuid()`.
 *  - Timestamps are integers in epoch-seconds with `mode: "timestamp"`, so
 *    Drizzle still hands the DAL `Date` objects.
 *  - Enums are `text`. The allowed values are enforced by the Zod schemas every
 *    write path already goes through, and by CHECK constraints in the migration.
 *  - `jsonb` becomes `text` holding JSON. `lib/config/settings.ts` and
 *    `lib/audit/log.ts` encode and decode explicitly, which is why both dialects
 *    use a plain text column.
 *
 * The one rule that does not change: **no table for mail bodies, attachments or
 * message lists.**
 */

/* ---------------------------------------------------------------- users */

export const users = sqliteTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Normalised (lower-cased) email. Unique: one Henna account per address. */
    email: text("email").notNull(),
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp" }),
    role: text("role").notNull().default("user"),

    displayName: text("display_name"),

    /** scrypt encoded hash; null for accounts that only use GitHub or OTP. */
    passwordHash: text("password_hash"),
    passwordUpdatedAt: integer("password_updated_at", { mode: "timestamp" }),

    /**
     * GitHub identity. `githubUserId` is the only binding key — never the email
     * and never the login, both of which GitHub lets a user change.
     */
    githubUserId: text("github_user_id"),
    githubLogin: text("github_login"),

    lockedAt: integer("locked_at", { mode: "timestamp" }),
    disabledAt: integer("disabled_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_github_user_id_unique").on(table.githubUserId),
    index("users_role_idx").on(table.role),
  ],
);

/* ------------------------------------------------------------- sessions */

export const sessions = sqliteTable(
  "sessions",
  {
    /**
     * Rotating session identifier. A new value is issued on every login and on
     * every successful MFA step, so a pre-authentication token cannot be
     * replayed afterwards.
     */
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Refresh tokens are stored as keyed digests only. */
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /** Rotation family; reuse of a rotated-out token kills the whole family. */
    familyId: text("family_id").notNull(),
    status: text("status").notNull().default("pending_mfa"),
    authMethod: text("auth_method").notNull().default("password"),
    mfaSatisfiedAt: integer("mfa_satisfied_at", { mode: "timestamp" }),
    accessExpiresAt: integer("access_expires_at", { mode: "timestamp" }).notNull(),
    refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp" }).notNull(),
    lastRotatedAt: integer("last_rotated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_family_idx").on(table.familyId),
    uniqueIndex("sessions_refresh_hash_unique").on(table.refreshTokenHash),
  ],
);

/* ----------------------------------------------------------------- TOTP */

export const totpSecrets = sqliteTable("totp_secrets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM `iv:authTag:ciphertext` of the base32 TOTP secret. */
  secretEnc: text("secret_enc").notNull(),
  keyId: text("key_id").notNull(),
  confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
  /**
   * Last accepted time step. A code from an already-used step is a replay and
   * must be rejected even though it is still inside the ±1 window.
   */
  lastUsedStep: integer("last_used_step"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Keyed digest of the code; plaintext is shown exactly once, at creation. */
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("recovery_codes_user_idx").on(table.userId)],
);

/* ----------------------------------------------------------- email OTP */

export const emailOtpCodes = sqliteTable(
  "email_otp_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Null for pre-registration codes issued to an unknown address. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: text("purpose").notNull().default("login"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("email_otp_email_idx").on(table.email),
    index("email_otp_expires_idx").on(table.expiresAt),
  ],
);

/* ------------------------------------------------- upstream credentials */

export const mailCredentials = sqliteTable(
  "mail_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("Primary"),
    protocol: text("protocol").notNull().default("jmap"),
    endpoint: text("endpoint").notNull(),
    port: integer("port"),
    username: text("username").notNull(),
    kind: text("kind").notNull().default("jmap_token"),
    secretEnc: text("secret_enc").notNull(),
    keyId: text("key_id").notNull(),
    lastDecryptedAt: integer("last_decrypted_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("mail_credentials_user_idx").on(table.userId)],
);

/* -------------------------------------------------------- user settings */

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  signature: text("signature").default(""),
  theme: text("theme").notNull().default("system"),
  messagesPerPage: integer("messages_per_page").notNull().default(25),
  /** Remote images stay blocked unless the user opts in per sender. */
  blockRemoteImages: integer("block_remote_images").notNull().default(1),
  transitionsEnabled: integer("transitions_enabled").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ---------------------------------------------------- instance settings */

export const instanceSettings = sqliteTable("instance_settings", {
  /** Singleton row; enforced by a CHECK constraint in the migration. */
  id: integer("id").primaryKey().default(1),
  /** JSON text. `lib/config/settings.ts` encodes and decodes it explicitly. */
  payload: text("payload").notNull().default("{}"),
  /**
   * Secrets kept in dedicated columns rather than inside `payload`, so a JSON
   * dump of the settings row never carries plaintext credentials.
   */
  githubClientSecretEnc: text("github_client_secret_enc"),
  githubClientSecretKeyId: text("github_client_secret_key_id"),
  resendApiKeyEnc: text("resend_api_key_enc"),
  resendApiKeyKeyId: text("resend_api_key_key_id"),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ------------------------------------------------------------- invites */

export const invites = sqliteTable(
  "invites",
  {
    code: text("code").primaryKey(),
    email: text("email"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp" }),
    usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("invites_email_idx").on(table.email)],
);

/* --------------------------------------------------------- audit log */

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    timestamp: integer("timestamp", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    actorId: text("actor_id"),
    /** Denormalised for readability; the authoritative link is `actorId`. */
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull().default("system"),
    resourceId: text("resource_id"),
    result: text("result").notNull().default("success"),
    actorRole: text("actor_role"),
    /** Hashed request fingerprints; Henna never stores raw IPs or UAs. */
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    /** JSON text. Secret-free by construction; see lib/audit/log.ts. */
    metadata: text("metadata"),
  },
  (table) => [
    index("audit_timestamp_idx").on(table.timestamp),
    index("audit_actor_idx").on(table.actorId),
    index("audit_action_idx").on(table.action),
  ],
);

/* -------------------------------------------------------- rate limits */

export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    /** `scope:subject`, e.g. `login:ip:<hash>` or `totp:user:<uuid>`. */
    key: text("key").primaryKey(),
    windowStartedAt: integer("window_started_at", { mode: "timestamp" }).notNull(),
    count: integer("count").notNull().default(0),
    blockedUntil: integer("blocked_until", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("rate_limit_blocked_idx").on(table.blockedUntil)],
);

/* ------------------------------------------------------- object storage */

export const storageConfig = sqliteTable("storage_config", {
  /** Singleton row; enforced by a CHECK constraint in the migration. */
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("r2"),
  enabled: integer("enabled").notNull().default(0),
  endpoint: text("endpoint"),
  r2AccountId: text("r2_account_id"),
  region: text("region").notNull().default("auto"),
  bucket: text("bucket"),
  accessKeyIdEnc: text("access_key_id_enc"),
  accessKeyIdKeyId: text("access_key_id_key_id"),
  secretAccessKeyEnc: text("secret_access_key_enc"),
  secretAccessKeyKeyId: text("secret_access_key_key_id"),
  forcePathStyle: integer("force_path_style").notNull().default(1),
  maxUploadBytes: integer("max_upload_bytes").notNull().default(26214400),
  signedUrlTtlSeconds: integer("signed_url_ttl_seconds").notNull().default(300),
  publicBaseUrl: text("public_base_url"),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const storageObjects = sqliteTable(
  "storage_objects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Always begins with `users/<userId>/`; enforced before signing. */
    objectKey: text("object_key").notNull(),
    purpose: text("purpose").notNull().default("attachment"),
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("storage_objects_key_unique").on(table.objectKey),
    index("storage_objects_user_idx").on(table.userId),
  ],
);

/* --------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  credentials: many(mailCredentials),
  recoveryCodes: many(recoveryCodes),
  totpSecret: one(totpSecrets, { fields: [users.id], references: [totpSecrets.userId] }),
  settings: one(userSettings, { fields: [users.id], references: [userSettings.userId] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const mailCredentialsRelations = relations(mailCredentials, ({ one }) => ({
  user: one(users, { fields: [mailCredentials.userId], references: [users.id] }),
}));

export const recoveryCodesRelations = relations(recoveryCodes, ({ one }) => ({
  user: one(users, { fields: [recoveryCodes.userId], references: [users.id] }),
}));

export const totpSecretsRelations = relations(totpSecrets, ({ one }) => ({
  user: one(users, { fields: [totpSecrets.userId], references: [users.id] }),
}));

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type MailCredentialRow = typeof mailCredentials.$inferSelect;
export type TotpSecretRow = typeof totpSecrets.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;
export type EmailOtpRow = typeof emailOtpCodes.$inferSelect;
