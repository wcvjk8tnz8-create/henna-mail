import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { Pool } from "pg";
import * as pgSchema from "./schema.pg";
import * as d1Schema from "./schema.d1";
import {
  detectRuntime,
  getD1Binding,
  resolveConnectionString,
  usesD1,
  type D1Binding,
} from "./runtime";

/**
 * Database factory.
 *
 * Three paths, selected at runtime, and only one of them needs any setup:
 *
 *  - **Cloudflare D1** — the default Workers path. The binding is declared by
 *    name in `wrangler.jsonc`, so Cloudflare creates the database on first
 *    deploy. No connection string, no external server, nothing to configure.
 *  - **Hyperdrive + PostgreSQL** — for operators who already run Postgres and
 *    want Workers in front of it. Never calls `pool.end()`; the platform owns
 *    the socket lifecycle.
 *  - **Node.js** — `DATABASE_URL` and a standard `pg` pool.
 *
 * Drizzle is always used with parameterised queries; no module in Henna builds
 * SQL by string concatenation.
 */

export type Database = NodePgDatabase<typeof pgSchema>;

export class DatabaseConfigError extends Error {
  override readonly name = "DatabaseConfigError";
}

let pool: Pool | null = null;
let db: Database | null = null;
let bootstrap: Promise<void> | null = null;

/**
 * Return the shared Drizzle handle.
 *
 * The D1 and Postgres drivers expose the same query-builder surface, so the rest
 * of the app is written once against `Database` and works on either. See the
 * note in `db/schema.ts` about the single cast that makes that possible.
 */
export function getDb(): Database {
  if (db !== null) return db;

  if (usesD1()) {
    const binding = getD1Binding();
    if (!binding) {
      throw new DatabaseConfigError(
        "HENNA_DB_KIND=d1 was requested but no D1 binding named DB is present. Add it to wrangler.jsonc.",
      );
    }
    db = drizzleD1(binding as unknown as Parameters<typeof drizzleD1>[0], {
      schema: d1Schema,
    }) as unknown as Database;
    return db;
  }

  const connectionString = resolveConnectionString();
  if (!connectionString.trim()) {
    throw new DatabaseConfigError(
      "No database configured. Provide DATABASE_URL, bind a D1 database named DB, or set a Hyperdrive config.",
    );
  }

  const runtime = detectRuntime();
  pool = new Pool({
    connectionString,
    max: runtime === "workers-pg" ? 5 : 10,
    idleTimeoutMillis: runtime === "workers-pg" ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    // Hyperdrive terminates TLS at the edge; on Node.js we require TLS unless
    // the host is loopback.
    ssl:
      connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: true },
  });

  db = drizzlePg(pool, { schema: pgSchema });
  return db;
}

/**
 * Create the schema if it does not exist yet.
 *
 * This is what makes the one-click deployment work: there is no `psql` on
 * Cloudflare, and asking someone to run a CLI command defeats the point of a
 * dashboard deploy. Every statement is `IF NOT EXISTS`, so this is idempotent
 * and safe to call on every cold start; a `_schema_migrations` row records that
 * it has been done.
 *
 * Cached in a promise, so concurrent requests during a cold start share one run.
 */
export async function ensureSchema(): Promise<void> {
  if (bootstrap !== null) return bootstrap;
  bootstrap = runBootstrap().catch((error: unknown) => {
    // Allow a later request to retry rather than caching the failure forever.
    bootstrap = null;
    throw error;
  });
  return bootstrap;
}

async function runBootstrap(): Promise<void> {
  if (!usesD1()) return;
  const binding = getD1Binding();
  if (!binding) return;

  await binding.prepare(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  ).run();

  const applied = await binding
    .prepare("SELECT name FROM _schema_migrations WHERE name = '0000_init'")
    .all();
  const rows = (applied.results ?? []) as Array<{ name?: string }>;
  if (rows.length > 0) return;

  const statements = splitSqlStatements(D1_SCHEMA_SQL);
  // D1 limits a batch to 100 statements; the schema is well under that.
  await binding.batch(statements.map((sql) => binding.prepare(sql)) as unknown[]);
  await binding
    .prepare(
      "INSERT OR IGNORE INTO _schema_migrations (name, applied_at) VALUES ('0000_init', ?)",
    )
    .run();
}

/**
 * Split a SQL script into single statements, and apply the D1 schema.
 *
 * Re-exported from `db/d1-schema.ts`, which deliberately has no `pg` import —
 * see the note there.
 */
export { D1_SCHEMA_SQL, splitSqlStatements, applyD1Schema } from "./d1-schema";

export function getDb(): Database {
  if (db !== null) return db;

  if (usesD1()) {
    const binding = getD1Binding();
    if (!binding) {
      throw new DatabaseConfigError(
        "HENNA_DB_KIND=d1 was requested but no D1 binding named DB is present. Add it to wrangler.jsonc.",
      );
    }
    db = drizzleD1(binding as unknown as Parameters<typeof drizzleD1>[0], {
      schema: d1Schema,
    }) as unknown as Database;
    return db;
  }

  const connectionString = resolveConnectionString();
  if (!connectionString.trim()) {
    throw new DatabaseConfigError(
      "No database configured. Provide DATABASE_URL, bind a D1 database named DB, or set a Hyperdrive config.",
    );
  }

  const runtime = detectRuntime();
  pool = new Pool({
    connectionString,
    max: runtime === "workers-pg" ? 5 : 10,
    idleTimeoutMillis: runtime === "workers-pg" ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    // Hyperdrive terminates TLS at the edge; on Node.js we require TLS unless
    // the host is loopback.
    ssl:
      connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: true },
  });

  db = drizzlePg(pool, { schema: pgSchema });
  return db;
}

/**
 * Create the schema if it does not exist yet.
 *
 * This is what makes the one-click deployment work: there is no `psql` on
 * Cloudflare, and asking someone to run a CLI command defeats the point of a
 * dashboard deploy. Every statement is `IF NOT EXISTS`, so this is idempotent
 * and safe to call on every cold start; a `_schema_migrations` row records that
 * it has been done.
 *
 * Cached in a promise, so concurrent requests during a cold start share one run.
 */
export async function ensureSchema(): Promise<void> {
  if (bootstrap !== null) return bootstrap;
  bootstrap = runBootstrap().catch((error: unknown) => {
    // Allow a later request to retry rather than caching the failure forever.
    bootstrap = null;
    throw error;
  });
  return bootstrap;
}

async function runBootstrap(): Promise<void> {
  if (!usesD1()) return;
  const binding = getD1Binding();
  if (!binding) return;

  await binding.prepare(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  ).run();

  const applied = await binding
    .prepare("SELECT name FROM _schema_migrations WHERE name = '0000_init'")
    .all();
  const rows = (applied.results ?? []) as Array<{ name?: string }>;
  if (rows.length > 0) return;

  const statements = splitSqlStatements(D1_SCHEMA_SQL);
  // D1 limits a batch to 100 statements; the schema is well under that.
  await binding.batch(statements.map((sql) => binding.prepare(sql)) as unknown[]);
  await binding
    .prepare(
      "INSERT OR IGNORE INTO _schema_migrations (name, applied_at) VALUES ('0000_init', ?)",
    )
    .run();
}

/**
 * Split a SQL script into single statements.
 *
 * Naive splitting is safe here because the schema script contains no
 * procedural blocks: it is CREATE TABLE / CREATE INDEX statements only.
 */
export function splitSqlStatements(script: string): readonly string[] {
  return script
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The D1 schema, embedded so no filesystem access is needed at runtime. */
export const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  email_verified_at INTEGER,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  password_hash TEXT,
  password_updated_at INTEGER,
  github_user_id TEXT,
  github_login TEXT,
  locked_at INTEGER,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT users_role_valid CHECK (role IN ('user','admin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_github_user_id_unique ON users (github_user_id);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  family_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_mfa',
  auth_method TEXT NOT NULL DEFAULT 'password',
  mfa_satisfied_at INTEGER,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  last_rotated_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at INTEGER NOT NULL,
  CONSTRAINT sessions_status_valid CHECK (status IN ('pending_mfa','active','revoked'))
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_hash_unique ON sessions (refresh_token_hash);

CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  confirmed_at INTEGER,
  last_used_step INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS email_otp_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  CONSTRAINT email_otp_purpose_valid CHECK (purpose IN ('login','password_reset'))
);
CREATE INDEX IF NOT EXISTS email_otp_email_idx ON email_otp_codes (email);
CREATE INDEX IF NOT EXISTS email_otp_expires_idx ON email_otp_codes (expires_at);

CREATE TABLE IF NOT EXISTS mail_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Primary',
  protocol TEXT NOT NULL DEFAULT 'jmap',
  endpoint TEXT NOT NULL,
  port INTEGER,
  username TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'jmap_token',
  secret_enc TEXT NOT NULL,
  key_id TEXT NOT NULL,
  last_decrypted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT mail_credentials_protocol_valid CHECK (protocol IN ('jmap','imap')),
  CONSTRAINT mail_credentials_kind_valid CHECK (kind IN ('jmap_token','imap_password','smtp_password'))
);
CREATE INDEX IF NOT EXISTS mail_credentials_user_idx ON mail_credentials (user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  signature TEXT DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'system',
  messages_per_page INTEGER NOT NULL DEFAULT 25,
  block_remote_images INTEGER NOT NULL DEFAULT 1,
  transitions_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  github_client_secret_enc TEXT,
  github_client_secret_key_id TEXT,
  resend_api_key_enc TEXT,
  resend_api_key_key_id TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  CONSTRAINT instance_settings_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_email_idx ON invites (email);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp INTEGER NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'system',
  resource_id TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  actor_role TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  metadata TEXT,
  CONSTRAINT audit_log_result_valid CHECK (result IN ('success','denied','error'))
);
CREATE INDEX IF NOT EXISTS audit_timestamp_idx ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE (ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE (ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_blocked_idx ON rate_limit_counters (blocked_until);

CREATE TABLE IF NOT EXISTS storage_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'r2',
  enabled INTEGER NOT NULL DEFAULT 0,
  endpoint TEXT,
  r2_account_id TEXT,
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT,
  access_key_id_enc TEXT,
  access_key_id_key_id TEXT,
  secret_access_key_enc TEXT,
  secret_access_key_key_id TEXT,
  force_path_style INTEGER NOT NULL DEFAULT 1,
  max_upload_bytes INTEGER NOT NULL DEFAULT 26214400,
  signed_url_ttl_seconds INTEGER NOT NULL DEFAULT 300,
  public_base_url TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  CONSTRAINT storage_config_singleton CHECK (id = 1),
  CONSTRAINT storage_config_provider_valid CHECK (provider IN ('r2','s3'))
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'attachment',
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_key_unique ON storage_objects (object_key);
CREATE INDEX IF NOT EXISTS storage_objects_user_idx ON storage_objects (user_id);
`;

/** Test-only escape hatch: swap in an in-memory or transaction-scoped handle. */
export function setDb(instance: Database | null): void {
  db = instance;
}

/** Graceful shutdown for long-lived Node.js processes. Never called on Workers. */
export async function closeDb(): Promise<void> {
  if (detectRuntime() !== "node") return;
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { pgSchema, d1Schema };
export { detectRuntime, usesD1 } from "./runtime";
