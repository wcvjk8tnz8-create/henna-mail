import * as d1 from "./schema.d1";
import * as pg from "./schema.pg";
import { usesD1 } from "./runtime";

/**
 * Dialect selection.
 *
 * Henna runs on two very different databases: Cloudflare D1 (SQLite) for the
 * one-click Workers deployment, and PostgreSQL for self-hosting. Both schema
 * modules declare the same tables with the same column names, so the query
 * builders in `lib/dal/` are written once and work on either.
 *
 * Which set is exported is decided at module load. The objects are typed as the
 * PostgreSQL ones — that is what the compiler checks the DAL against — while the
 * runtime object is whatever the platform actually provides. It is one
 * deliberate cast in one file, rather than a cast at every call site, and it is
 * safe because every column name and query shape is identical across the two.
 */

export const dialect: "d1" | "postgres" = usesD1() ? "d1" : "postgres";

const impl = (dialect === "d1" ? d1 : pg) as unknown as typeof pg;

export const {
  users,
  sessions,
  totpSecrets,
  recoveryCodes,
  emailOtpCodes,
  mailCredentials,
  userSettings,
  instanceSettings,
  invites,
  auditLog,
  rateLimitCounters,
  storageConfig,
  storageObjects,
} = impl;

export const {
  usersRelations,
  sessionsRelations,
  mailCredentialsRelations,
  recoveryCodesRelations,
  totpSecretsRelations,
  userSettingsRelations,
} = impl;

export type User = typeof pg.users.$inferSelect;
export type NewUser = typeof pg.users.$inferInsert;
export type SessionRow = typeof pg.sessions.$inferSelect;
export type AuditRow = typeof pg.auditLog.$inferSelect;
export type MailCredentialRow = typeof pg.mailCredentials.$inferSelect;
export type TotpSecretRow = typeof pg.totpSecrets.$inferSelect;
export type RecoveryCodeRow = typeof pg.recoveryCodes.$inferSelect;
export type EmailOtpRow = typeof pg.emailOtpCodes.$inferSelect;

export { pg as pgSchema, d1 as d1Schema };
