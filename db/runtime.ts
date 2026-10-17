/**
 * Runtime detection and Cloudflare binding access.
 *
 * This module deliberately imports nothing from the schema, so both schema
 * modules can depend on it without a cycle. It answers one question — are we on
 * Workers with a D1 binding, or on Node.js with a Postgres URL — and that answer
 * decides which Drizzle dialect the rest of the app is built on.
 */

export type RuntimeKind = "workers-d1" | "workers-pg" | "node";

/** Minimal shape of the D1 binding Henna declares in wrangler.jsonc. */
export interface D1Binding {
  prepare(sql: string): { run(): Promise<unknown>; all(): Promise<{ results?: unknown[] }> };
  batch(statements: unknown[]): Promise<unknown[]>;
}

interface CloudflareEnvShape {
  DB?: D1Binding;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}

/**
 * Workers bindings are objects, not strings, so they are not visible on
 * `process.env`. OpenNext exposes them on a global; the fallback covers the
 * case where they are injected some other way.
 */
function getCloudflareEnv(): CloudflareEnvShape | null {
  const candidate = (globalThis as { __hennaCloudflareEnv__?: CloudflareEnvShape })
    .__hennaCloudflareEnv__;
  if (candidate && (candidate.DB || candidate.HYPERDRIVE || candidate.DATABASE_URL)) {
    return candidate;
  }
  const legacy = (process.env as Record<string, unknown>).HYPERDRIVE;
  if (typeof legacy === "object" && legacy !== null) {
    return legacy as CloudflareEnvShape;
  }
  return null;
}

export function getD1Binding(): D1Binding | null {
  return getCloudflareEnv()?.DB ?? null;
}

export function detectRuntime(): RuntimeKind {
  const cf = getCloudflareEnv();
  if (cf?.DB) return "workers-d1";
  if (cf?.HYPERDRIVE || cf?.DATABASE_URL) return "workers-pg";
  if (process.env.HENNA_RUNTIME === "workers") {
    return process.env.HENNA_DB_KIND === "postgres" ? "workers-pg" : "workers-d1";
  }
  return "node";
}

/** True when the SQLite/D1 dialect should be used. */
export function usesD1(): boolean {
  return detectRuntime() === "workers-d1" || process.env.HENNA_DB_KIND === "d1";
}

export function resolveConnectionString(): string {
  const cf = getCloudflareEnv();
  if (cf?.HYPERDRIVE?.connectionString) return cf.HYPERDRIVE.connectionString;
  if (cf?.DATABASE_URL) return cf.DATABASE_URL;
  return process.env.DATABASE_URL ?? "";
}
