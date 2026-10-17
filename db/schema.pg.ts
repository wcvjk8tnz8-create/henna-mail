import { randomUUID } from "node:crypto";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * Henna's PostgreSQL schema — the self-hosted and Hyperdrive paths.
 *
 * Hard rule encoded here: **there is no table for mail bodies, attachments or
 * message lists.** Henna's server stores identity, encrypted upstream
 * credentials, TOTP material, settings and an append-only audit log. Mail
 * content lives in the browser (or in a local IndexedDB cache) and on the
 * upstream server, never in these tables.
 */

/* ---------------------------------------------------------------- enums */

export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const sessionStatusEnum = pgEnum("session_status", ["pending_mfa", "active", "revoked"]);
export const otpPurposeEnum = pgEnum("otp_purpose", ["login", "password_reset"]);
export const mailProtocolEnum = pgEnum("mail_protocol", ["jmap", "imap"]);
export const auditResultEnum = pgEnum("audit_result", ["success", "denied", "error"]);
export const credentialKindEnum = pgEnum("credential_kind", [
  "jmap_token",
  "imap_password",
  "smtp_password",
]);

/* ---------------------------------------------------------------- users */

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Normalised (lower-cased) email. Unique: one Henna account per address. */
    email: text("email").notNull(),
    /** Null until the address has been proven with an OTP or a verified GitHub email. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    role: userRoleEnum("role").notNull().default("user"),

    displayName: text("display_name"),

    /** scrypt encoded hash; null for accounts that only use GitHub or OTP. */
    passwordHash: text("password_hash"),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),

    /**
     * GitHub identity. `githubUserId` is the only binding key — never the
     * email and never the login, both of which GitHub lets a user change.
     */
    githubUserId: text("github_user_id"),
    githubLogin: text("github_login"),

    /** Set when brute-force protection trips; cleared by an administrator. */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_github_user_id_unique").on(table.githubUserId),
    index("users_role_idx").on(table.role),
  ],
);

/* ------------------------------------------------------------- sessions */

export const sessions = pgTable(
  "sessions",
  {
    /**
     * Rotating session identifier. A new value is issued on every login and on
     * every successful MFA step, so a pre-authentication session token cannot
     * be replayed afterwards.
     */
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Refresh tokens are stored as keyed digests only. */
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /** Rotation family; reuse of a rotated-out token kills the whole family. */
    familyId: uuid("family_id").notNull(),
    status: sessionStatusEnum("status").notNull().default("pending_mfa"),
    /** Which primary authentication established this session. */
    authMethod: text("auth_method").notNull().default("password"),
    /** Set once the second factor has been satisfied. */
    mfaSatisfiedAt: timestamp("mfa_satisfied_at", { withTimezone: true }),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_family_idx").on(table.familyId),
    uniqueIndex("sessions_refresh_hash_unique").on(table.refreshTokenHash),
  ],
);

/* ----------------------------------------------------------------- TOTP */

export const totpSecrets = pgTable("totp_secrets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM `iv:authTag:ciphertext` of the base32 TOTP secret. */
  secretEnc: text("secret_enc").notNull(),
  /** Fingerprint of the credential key used; surfaced by key-rotation status. */
  keyId: text("key_id").notNull(),
  /** Null until the user proves a first code from their authenticator. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  /**
   * Last accepted time step. A code from an already-used step is a replay and
   * must be rejected even though it is still inside the ±1 window.
   */
  lastUsedStep: integer("last_used_step"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Keyed digest of the code; plaintext is shown exactly once, at creation. */
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("recovery_codes_user_idx").on(table.userId)],
);

/* ----------------------------------------------------------- email OTP */

export const emailOtpCodes = pgTable(
  "email_otp_codes",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Null for pre-registration codes issued to an unknown address. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: otpPurposeEnum("purpose").notNull().default("login"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("email_otp_email_idx").on(table.email),
    index("email_otp_expires_idx").on(table.expiresAt),
  ],
);

/* ------------------------------------------------- upstream credentials */

export const mailCredentials = pgTable(
  "mail_credentials",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull().default("Primary"),
    protocol: mailProtocolEnum("protocol").notNull().default("jmap"),
    /** JMAP session URL, or IMAP host. Validated against an allow-list. */
    endpoint: text("endpoint").notNull(),
    port: integer("port"),
    username: text("username").notNull(),
    /** What is encrypted: a JMAP bearer/API token, or an IMAP/SMTP password. */
    kind: credentialKindEnum("kind").notNull().default("jmap_token"),
    secretEnc: text("secret_enc").notNull(),
    keyId: text("key_id").notNull(),
    lastDecryptedAt: timestamp("last_decrypted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mail_credentials_user_idx").on(table.userId)],
);

/* -------------------------------------------------------- user settings */

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  signature: text("signature").default(""),
  theme: text("theme").notNull().default("system"),
  messagesPerPage: integer("messages_per_page").notNull().default(25),
  /** Remote images stay blocked unless the user opts in per sender. */
  blockRemoteImages: integer("block_remote_images").notNull().default(1),
  transitionsEnabled: integer("transitions_enabled").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------------------------------------- instance settings */

export const instanceSettings = pgTable("instance_settings", {
  /** Singleton row; enforced by a check constraint in the migration. */
  id: integer("id").primaryKey().default(1),
  /**
   * JSON text rather than `jsonb`: the D1 schema has to use `text`, and one
   * representation for both dialects removes a whole class of "works on
   * Postgres, silently stringifies on D1" bugs. The settings layer encodes and
   * decodes it explicitly.
   */
  payload: text("payload").notNull().default("{}"),
  /**
   * Secrets kept in dedicated columns rather than inside `payload` so that a
   * JSON dump of the settings row never carries plaintext credentials.
   */
  githubClientSecretEnc: text("github_client_secret_enc"),
  githubClientSecretKeyId: text("github_client_secret_key_id"),
  resendApiKeyEnc: text("resend_api_key_enc"),
  resendApiKeyKeyId: text("resend_api_key_key_id"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------- invites */

export const invites = pgTable(
  "invites",
  {
    code: text("code").primaryKey(),
    email: text("email"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("invites_email_idx").on(table.email)],
);

/* --------------------------------------------------------- audit log */

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    /** Denormalised for readability; the authoritative link is `actorId`. */
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull().default("system"),
    resourceId: text("resource_id"),
    result: auditResultEnum("result").notNull().default("success"),
    actorRole: text("actor_role"),
    /** Hashed request fingerprints; Henna never stores raw IPs or UAs. */
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    /** Structured, secret-free context. Never contains secrets or plaintext codes. */
    /** JSON text; see the note on `instanceSettings.payload`. */
    metadata: text("metadata"),
  },
  (table) => [
    index("audit_timestamp_idx").on(table.timestamp),
    index("audit_actor_idx").on(table.actorId),
    index("audit_action_idx").on(table.action),
  ],
);

/* -------------------------------------------------------- rate limits */

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    /** `scope:subject`, e.g. `login:ip:<hash>` or `totp:user:<uuid>`. */
    key: text("key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("rate_limit_blocked_idx").on(table.blockedUntil)],
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

/* ------------------------------------------------------- object storage */

/**
 * Configuration for R2 or any S3-compatible bucket.
 *
 * The bucket credentials live in dedicated encrypted columns, never in a
 * plaintext column, for the same reason as the mail credentials: a dump of this
 * table must not hand over write access to someone's bucket.
 */
export const storageConfig = pgTable("storage_config", {
  /** Singleton row; enforced by a check constraint in the migration. */
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("r2"),
  enabled: integer("enabled").notNull().default(0),
  /** Origin only. Derived from `r2AccountId` when empty and provider is r2. */
  endpoint: text("endpoint"),
  r2AccountId: text("r2_account_id"),
  /** `auto` for R2; a real region for S3 and most S3-compatible services. */
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
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Metadata about objects a user has put in the bucket.
 *
 * Note what is *not* here: no bytes, no inline content, nothing that could be
 * read back as mail. Henna records that an object exists and where it lives;
 * the object itself moves browser <-> bucket through a presigned URL.
 */
export const storageObjects = pgTable(
  "storage_objects",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Always begins with `users/<userId>/`; enforced before signing. */
    objectKey: text("object_key").notNull(),
    purpose: text("purpose").notNull().default("attachment"),
    /** The name shown in the UI; the stored key carries a UUID instead. */
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_objects_key_unique").on(table.objectKey),
    index("storage_objects_user_idx").on(table.userId),
  ],
);
