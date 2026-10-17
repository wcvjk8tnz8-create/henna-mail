-- 0000_init.sql — Henna initial schema.
--
-- Generated from db/schema.ts.
--
-- Two rules encoded here, not just in application code:
--
--  1. There is no table for mail bodies, attachments or message lists. Henna's
--     server stores identity, encrypted upstream credentials, TOTP material,
--     settings and an append-only audit log — never mail content.
--  2. `audit_log` is append-only at the database level. The application's role
--     is granted INSERT and SELECT only, and the trigger below rejects UPDATE
--     and DELETE even for a role that was granted them by mistake.

CREATE TYPE "user_role" AS ENUM ('user', 'admin');
CREATE TYPE "session_status" AS ENUM ('pending_mfa', 'active', 'revoked');
CREATE TYPE "otp_purpose" AS ENUM ('login', 'password_reset');
CREATE TYPE "mail_protocol" AS ENUM ('jmap', 'imap');
CREATE TYPE "audit_result" AS ENUM ('success', 'denied', 'error');
CREATE TYPE "credential_kind" AS ENUM ('jmap_token', 'imap_password', 'smtp_password');

-- ------------------------------------------------------------------ users --
-- One Henna account per address, and at most one account per GitHub identity.
-- github_user_id is the binding key: neither the email nor the login is stable
-- enough to identify someone, because GitHub lets both be changed.

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "email_verified_at" timestamptz,
  "role" "user_role" NOT NULL DEFAULT 'user',
  "display_name" text,
  "password_hash" text,
  "password_updated_at" timestamptz,
  "github_user_id" text,
  "github_login" text,
  "locked_at" timestamptz,
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");
CREATE UNIQUE INDEX "users_github_user_id_unique" ON "users" ("github_user_id");
CREATE INDEX "users_role_idx" ON "users" ("role");

-- --------------------------------------------------------------- sessions --
-- The identifier is rotated on login and again when the second factor is
-- satisfied, so a pre-MFA token cannot be replayed afterwards.

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  -- Only a keyed digest of the refresh token is stored.
  "refresh_token_hash" text NOT NULL,
  "family_id" uuid NOT NULL,
  "status" "session_status" NOT NULL DEFAULT 'pending_mfa',
  "auth_method" text NOT NULL DEFAULT 'password',
  "mfa_satisfied_at" timestamptz,
  "access_expires_at" timestamptz NOT NULL,
  "refresh_expires_at" timestamptz NOT NULL,
  "last_rotated_at" timestamptz NOT NULL DEFAULT now(),
  "ip_hash" text,
  "user_agent_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
CREATE INDEX "sessions_family_idx" ON "sessions" ("family_id");
CREATE UNIQUE INDEX "sessions_refresh_hash_unique" ON "sessions" ("refresh_token_hash");

-- ------------------------------------------------------------------- TOTP --

CREATE TABLE "totp_secrets" (
  "user_id" uuid PRIMARY KEY REFERENCES "users" ("id") ON DELETE CASCADE,
  -- AES-256-GCM output in iv:authTag:ciphertext form.
  "secret_enc" text NOT NULL,
  "key_id" text NOT NULL,
  "confirmed_at" timestamptz,
  -- Replay guard: a code from this step or earlier is refused.
  "last_used_step" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" ("user_id");

-- ------------------------------------------------------------- email OTP --

CREATE TABLE "email_otp_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "users" ("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "code_hash" text NOT NULL,
  "purpose" "otp_purpose" NOT NULL DEFAULT 'login',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "ip_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "email_otp_email_idx" ON "email_otp_codes" ("email");
CREATE INDEX "email_otp_expires_idx" ON "email_otp_codes" ("expires_at");

-- --------------------------------------------------- upstream credentials --

CREATE TABLE "mail_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "label" text NOT NULL DEFAULT 'Primary',
  "protocol" "mail_protocol" NOT NULL DEFAULT 'jmap',
  "endpoint" text NOT NULL,
  "port" integer,
  "username" text NOT NULL,
  "kind" "credential_kind" NOT NULL DEFAULT 'jmap_token',
  "secret_enc" text NOT NULL,
  "key_id" text NOT NULL,
  "last_decrypted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "mail_credentials_user_idx" ON "mail_credentials" ("user_id");

-- ---------------------------------------------------------- user settings --

CREATE TABLE "user_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "users" ("id") ON DELETE CASCADE,
  "signature" text DEFAULT '',
  "theme" text NOT NULL DEFAULT 'system',
  "messages_per_page" integer NOT NULL DEFAULT 25,
  "block_remote_images" integer NOT NULL DEFAULT 1,
  "transitions_enabled" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------ instance settings --
-- Secrets live in their own encrypted columns, never inside the JSON payload,
-- so an export of this table cannot leak a credential.

CREATE TABLE "instance_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "github_client_secret_enc" text,
  "github_client_secret_key_id" text,
  "resend_api_key_enc" text,
  "resend_api_key_key_id" text,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "instance_settings_singleton" CHECK ("id" = 1)
);

-- --------------------------------------------------------------- invites --

CREATE TABLE "invites" (
  "code" text PRIMARY KEY,
  "email" text,
  "created_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "used_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "invites_email_idx" ON "invites" ("email");

-- ------------------------------------------------------------- audit log --

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  "actor_id" uuid,
  "actor_email" text,
  "action" text NOT NULL,
  "resource_type" text NOT NULL DEFAULT 'system',
  "resource_id" text,
  "result" "audit_result" NOT NULL DEFAULT 'success',
  "actor_role" text,
  -- Hashed fingerprints only: Henna never stores raw IPs or user agents.
  "ip_hash" text,
  "user_agent_hash" text,
  "metadata" jsonb
);
CREATE INDEX "audit_timestamp_idx" ON "audit_log" ("timestamp");
CREATE INDEX "audit_actor_idx" ON "audit_log" ("actor_id");
CREATE INDEX "audit_action_idx" ON "audit_log" ("action");

-- Append-only, enforced by the database rather than by convention.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; UPDATE and DELETE are not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ------------------------------------------------------------ rate limits --

CREATE TABLE "rate_limit_counters" (
  "key" text PRIMARY KEY,
  "window_started_at" timestamptz NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "blocked_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "rate_limit_blocked_idx" ON "rate_limit_counters" ("blocked_until");
