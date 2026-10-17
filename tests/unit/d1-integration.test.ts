import { afterAll, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import * as d1Schema from "@/db/schema.d1";
import { D1_SCHEMA_SQL, splitSqlStatements } from "@/db/d1-schema";
import { installTestEnv } from "./helpers/env";

/**
 * Backend integration test.
 *
 * Everything else in tests/unit exercises pure logic against stubs. This file
 * runs the real thing: the hand-written D1 schema against a real SQLite engine,
 * and then the Drizzle table definitions the DAL is built on.
 *
 * It exists because the D1 schema is written by hand and shipped inside the
 * Worker. If it contained a syntax error, or a column that disagreed with
 * `schema.d1.ts`, every deployment would fail on its first request and no unit
 * test would notice. SQLite is compiled to WebAssembly here, so this runs with
 * no native toolchain — and deliberately avoids importing `db/index.ts`, so the
 * D1 and PostgreSQL paths stay independent.
 */

let SQL: SqlJsStatic;
let raw: SqlJsDatabase;
let db: ReturnType<typeof drizzle<typeof d1Schema>>;

/** Read a table back with no ORM in the way, to assert on what was persisted. */
function rowsOf(table: string): Array<Record<string, unknown>> {
  const stmt = raw.prepare(`SELECT * FROM ${table}`);
  const rows: Array<Record<string, unknown>> = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
  stmt.free();
  return rows;
}

function tableNames(): readonly string[] {
  const stmt = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const names: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { name?: string };
    if (row.name) names.push(row.name);
  }
  stmt.free();
  return names;
}

beforeAll(async () => {
  installTestEnv();

  SQL = await initSqlJs();
  raw = new SQL.Database();

  // Exactly what ensureSchema() runs on a cold start. If any statement is
  // malformed, SQLite raises here and the suite fails.
  for (const statement of splitSqlStatements(D1_SCHEMA_SQL)) {
    raw.run(statement);
  }

  db = drizzle(
    async (statement: string, params: unknown[]) => {
      const stmt = raw.prepare(statement);
      stmt.bind(params as Array<string | number | Uint8Array | null>);
      // Positional arrays, not objects: this is what drizzle-orm's SQLite proxy
      // driver expects, and it maps them back onto the declared columns.
      const rows: Array<Array<unknown>> = [];
      while (stmt.step()) rows.push(stmt.get() as Array<unknown>);
      stmt.free();
      return { rows };
    },
    { schema: d1Schema },
  );
});

afterAll(() => {
  raw?.close();
});

describe("D1 schema", () => {
  it("creates every table Henna needs", () => {
    const names = tableNames();
    for (const table of [
      "users",
      "sessions",
      "totp_secrets",
      "recovery_codes",
      "email_otp_codes",
      "mail_credentials",
      "user_settings",
      "instance_settings",
      "invites",
      "audit_log",
      "rate_limit_counters",
      "storage_config",
      "storage_objects",
    ]) {
      expect(names, `${table} is missing from the schema`).toContain(table);
    }
  });

  it("has no table that could hold mail content", () => {
    const names = tableNames();
    for (const forbidden of ["messages", "mail_bodies", "attachments"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("is idempotent — applying it twice is safe", () => {
    expect(() => {
      for (const statement of splitSqlStatements(D1_SCHEMA_SQL)) raw.run(statement);
    }).not.toThrow();
  });
});

describe("users", () => {
  it("inserts and reads a user", async () => {
    const inserted = await db
      .insert(d1Schema.users)
      .values({
        email: "root@example.com",
        role: "admin",
        displayName: "Root",
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.role).toBe("admin");
    expect(inserted[0]?.email).toBe("root@example.com");
    // Verification is unhashed and unshortened by reading the table directly:
    // what matters is what landed in the database, not what the ORM reports.
    expect(rowsOf("users")).toHaveLength(1);
    expect(rowsOf("users")[0]?.email_verified_at).toBeNull();
  });

  it("enforces one account per email address", async () => {
    await expect(
      db.insert(d1Schema.users).values({ email: "root@example.com", role: "user" }),
    ).rejects.toThrow();
  });

  it("enforces one account per GitHub user id", async () => {
    await db
      .insert(d1Schema.users)
      .values({ email: "a@example.com", githubUserId: "42", role: "user" });
    await expect(
      db.insert(d1Schema.users).values({ email: "b@example.com", githubUserId: "42" }),
    ).rejects.toThrow();
  });

  it("rejects a role outside the allow-list", async () => {
    await expect(
      db.insert(d1Schema.users).values({ email: "c@example.com", role: "owner" }),
    ).rejects.toThrow();
  });
});

describe("audit log", () => {
  it("accepts an insert", async () => {
    await db.insert(d1Schema.auditLog).values({
      action: "auth.password.login.success",
      result: "success",
      actorEmail: "root@example.com",
      resourceType: "auth",
      metadata: JSON.stringify({ method: "password" }),
    });
    expect(rowsOf("audit_log")).toHaveLength(1);
  });

  it("refuses UPDATE — the append-only trigger fires", () => {
    expect(() => raw.run("UPDATE audit_log SET result = 'denied'")).toThrow();
  });

  it("refuses DELETE — the append-only trigger fires", () => {
    expect(() => raw.run("DELETE FROM audit_log")).toThrow();
  });
});

describe("settings and credential storage", () => {
  it("keeps the settings payload as a singleton", async () => {
    await db
      .insert(d1Schema.instanceSettings)
      .values({ id: 1, payload: JSON.stringify({ totpPolicy: "required" }) });
    expect(rowsOf("instance_settings")).toHaveLength(1);
    await expect(
      db.insert(d1Schema.instanceSettings).values({ id: 2, payload: "{}" }),
    ).rejects.toThrow();
  });

  it("stores only ciphertext in the credential column", async () => {
    await db.insert(d1Schema.mailCredentials).values({
      userId: rowsOf("users")[0]?.id as string,
      label: "Primary",
      protocol: "jmap",
      endpoint: "https://mail.example.com/jmap",
      username: "root@example.com",
      kind: "jmap_token",
      secretEnc: "iv:tag:ciphertext",
      keyId: "test-key",
    });

    const dump = JSON.stringify(rowsOf("mail_credentials"));
    expect(dump).toContain("iv:tag:ciphertext");
    // There is nowhere in this schema for a plaintext secret to hide.
    expect(dump).not.toMatch(/password":\s*"/);
  });
});
