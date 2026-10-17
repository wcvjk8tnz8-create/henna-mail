/**
 * The audit event vocabulary.
 *
 * Action names are stable strings so that log shippers and alerts can key off
 * them. Every event carries a `result` of success / denied / error; a denied
 * action is as important as a successful one, because the denial is what tells
 * you an attack was attempted.
 */

export const AUDIT_ACTIONS = {
  /* Primary authentication */
  LOGIN_PASSWORD_SUCCESS: "auth.password.login.success",
  LOGIN_PASSWORD_FAILED: "auth.password.login.failed",
  LOGIN_GITHUB_SUCCESS: "auth.github.login.success",
  LOGIN_GITHUB_FAILED: "auth.github.login.failed",
  LOGIN_GITHUB_DENIED_NOT_ALLOWED: "auth.github.login.denied_not_allowed",
  LOGIN_GITHUB_STATE_INVALID: "auth.github.login.state_invalid",
  LOGIN_EMAIL_OTP_SENT: "auth.email_otp.sent",
  LOGIN_EMAIL_OTP_SUCCESS: "auth.email_otp.success",
  LOGIN_EMAIL_OTP_FAILED: "auth.email_otp.failed",
  LOGIN_METHOD_DISABLED: "auth.login.method_disabled",
  LOGIN_LOCKED_OUT: "auth.login.locked_out",

  /* Account lifecycle */
  ACCOUNT_CREATED: "account.created",
  ACCOUNT_BOUND_GITHUB: "account.github.bound",
  ACCOUNT_UNBOUND_GITHUB: "account.github.unbound",
  PASSWORD_CHANGED: "account.password.changed",
  PASSWORD_RESET_REQUESTED: "account.password_reset.requested",
  PASSWORD_RESET_COMPLETED: "account.password_reset.completed",
  SESSION_REVOKED: "session.revoked",
  SESSION_ROTATED: "session.rotated",
  SESSION_EXPIRED: "session.expired",
  LOGOUT: "session.logout",

  /* Second factor */
  TOTP_ENROLLED: "mfa.totp.enrolled",
  TOTP_DISABLED: "mfa.totp.disabled",
  TOTP_VERIFY_SUCCESS: "mfa.totp.verify.success",
  TOTP_VERIFY_FAILED: "mfa.totp.verify.failed",
  TOTP_REQUIRED_DENIED: "mfa.totp.required_denied",
  RECOVERY_CODE_USED: "mfa.recovery_code.used",
  RECOVERY_CODE_REGENERATED: "mfa.recovery_code.regenerated",

  /* Credentials */
  CREDENTIAL_CREATED: "credential.created",
  CREDENTIAL_DECRYPTED: "credential.decrypted",
  CREDENTIAL_DECRYPT_FAILED: "credential.decrypt_failed",
  CREDENTIAL_DELETED: "credential.deleted",
  SECRET_DECRYPTED: "secret.decrypted",
  KEY_ROTATION: "crypto.key_rotation",

  /* Administration */
  ADMIN_SETTINGS_UPDATED: "admin.settings.updated",
  ADMIN_USER_ROLE_CHANGED: "admin.user.role_changed",
  ADMIN_USER_LOCKED: "admin.user.locked",
  ADMIN_USER_UNLOCKED: "admin.user.unlocked",
  ADMIN_AUDIT_EXPORTED: "admin.audit.exported",

  /* Object storage */
  STORAGE_CONFIG_UPDATED: "storage.config.updated",
  STORAGE_UPLOAD_URL_ISSUED: "storage.upload_url.issued",
  STORAGE_DOWNLOAD_URL_ISSUED: "storage.download_url.issued",
  STORAGE_URL_DENIED: "storage.url.denied",
  STORAGE_OBJECT_DELETED: "storage.object.deleted",

  /* Authorisation failures */
  ACCESS_DENIED: "authz.denied",
  CSRF_REJECTED: "authz.csrf_rejected",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditResult = "success" | "denied" | "error";

export interface AuditEvent {
  readonly action: AuditAction;
  readonly result: AuditResult;
  readonly actorId?: string | null;
  readonly actorEmail?: string | null;
  readonly actorRole?: string | null;
  readonly resourceType?: string;
  readonly resourceId?: string | null;
  readonly ipHash?: string | null;
  readonly userAgentHash?: string | null;
  /**
   * Structured context. Callers must never place a password, an OTP code, a
   * TOTP code, a recovery code, a session token or a decrypted credential in
   * here; `writeAudit` rejects a denylist of key names as a backstop.
   */
  readonly metadata?: Record<string, unknown>;
}

/** Keys whose presence in `metadata` would leak a secret. */
const FORBIDDEN_METADATA_KEYS: readonly string[] = [
  "password",
  "newPassword",
  "currentPassword",
  "code",
  "otp",
  "otpCode",
  "token",
  "secret",
  "secretEnc",
  "clientSecret",
  "apiKey",
  "accessKeyId",
  "secretAccessKey",
  "credential",
  "refreshToken",
  "sessionToken",
  "recoveryCode",
];
