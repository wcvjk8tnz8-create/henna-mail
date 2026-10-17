import { createHmac } from "node:crypto";
import { z } from "zod";
import type { RootEnv } from "./schema";
import { rootEnvSchema } from "./schema";

/**
 * Root configuration — environment variables only.
 *
 * `DOMAIN`, `ADMIN` and `jwt_secret` are the three root settings of a Henna
 * instance: they define which mail domains the instance serves, which identity
 * bootstraps as administrator, and what signs session tokens. If any is
 * missing or malformed the process refuses to start with a readable message
 * rather than falling back to a guessable default.
 *
 * Every other module reads configuration through `lib/config`, never through
 * `process.env` directly.
 */

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(formatMessage(message, issues));
    this.issues = issues;
  }
}

function formatMessage(message: string, issues: readonly string[]): string {
  if (issues.length === 0) return message;
  return [
    message,
    "",
    "Resolve each of the following and restart:",
    ...issues.map((issue) => `  - ${issue}`),
    "",
    "See docs/self-hosting.md for how to provide these values.",
  ].join("\n");
}

/** Variable names that must never appear with a NEXT_PUBLIC_ prefix. */
const FORBIDDEN_PUBLIC_NAMES: readonly string[] = [
  "JWT_SECRET",
  "CREDENTIAL_KEY",
  "CLIENT_SECRET",
  "API_KEY",
  "SECRET",
  "DATABASE_URL",
  "PASSWORD",
  "TOKEN",
];

/**
 * Any `NEXT_PUBLIC_*` value is compiled into the browser bundle. Failing the
 * boot when one of them looks like a secret is the last line of defence behind
 * code review.
 */
export function assertNoSecretIsPublic(env: Record<string, string | undefined>): void {
  const offenders: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    const upper = name.slice("NEXT_PUBLIC_".length).toUpperCase();
    if (FORBIDDEN_PUBLIC_NAMES.some((needle) => upper.includes(needle)) && value) {
      offenders.push(name);
    }
  }
  if (offenders.length > 0) {
    throw new ConfigError(
      "A secret was exposed through a NEXT_PUBLIC_ environment variable.",
      offenders.map((name) => `${name} is bundled into the browser; remove it and rotate the value`),
    );
  }
}

/**
 * Source of environment values.
 *
 * On Cloudflare Workers, OpenNext populates `process.env` from wrangler
 * variables and secrets at runtime, so a single lookup path is enough. This
 * indirection exists so tests can inject values without touching globals.
 */
let envSource: () => Record<string, string | undefined> = () => process.env;

export function setEnvSource(source: () => Record<string, string | undefined>): void {
  envSource = source;
  resetEnvCache();
}

export function rawEnv(): Record<string, string | undefined> {
  return envSource();
}

let cached: RootEnv | null = null;

export function resetEnvCache(): void {
  cached = null;
}

/** Parse and cache the root configuration. Throws `ConfigError` when invalid. */
export function getRootConfig(): RootEnv {
  if (cached !== null) return cached;

  const raw = envSource();
  assertNoSecretIsPublic(raw as Record<string, string | undefined>);

  const result = rootEnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = z.prettifyError(result.error)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    throw new ConfigError("Henna is not configured correctly.", issues);
  }

  cached = result.data;
  return cached;
}

/**
 * Like `getRootConfig()` but returns `null` instead of throwing. Used by
 * health checks so that a misconfigured instance can report *why* it is
 * unhealthy instead of only crashing.
 */
export function tryGetRootConfig(): { ok: true; value: RootEnv } | { ok: false; error: ConfigError } {
  try {
    return { ok: true, value: getRootConfig() };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, error };
    }
    throw error;
  }
}

/** Mail domains served by this instance, e.g. `["example.com"]`. */
export function getMailDomains(): readonly string[] {
  return getRootConfig().DOMAIN;
}

/** The bootstrap administrator's email address. */
export function getAdminEmail(): string {
  return getRootConfig().ADMIN;
}

/** Session/JWT signing secret. */
export function getJwtSecret(): string {
  return getRootConfig().jwt_secret;
}

/**
 * Comma separated AES-256-GCM keyring.
 *
 * Falls back to a key derived from `jwt_secret` when the variable is not set,
 * so that a Cloudflare deploy needs only DOMAIN, ADMIN and jwt_secret. The
 * derivation is HKDF-SHA256 with a fixed, purpose-specific info string, so the
 * result is an independent 32-byte key rather than a reuse of the signing
 * secret.
 *
 * The trade-off is worth stating plainly: deriving means rotating `jwt_secret`
 * also rotates the credential key, which invalidates stored credentials unless
 * you keep the old key in the keyring during the change. Setting
 * `HENNA_CREDENTIAL_KEY` explicitly decouples the two, and is recommended for
 * anything long-lived.
 */
export function getCredentialKeyRaw(): string {
  const explicit = getRootConfig().HENNA_CREDENTIAL_KEY;
  if (explicit && explicit.trim() !== "") return explicit;
  return deriveCredentialKey(getRootConfig().jwt_secret);
}

/** Same derivation as `getCredentialKeyRaw()`, exposed for tests and docs. */
export function deriveCredentialKey(jwtSecret: string): string {
  return hkdfBase64(jwtSecret, "henna-credential-key-v1", 32);
}

/**
 * HKDF-SHA256 (RFC 5869), implemented with HMAC so it runs on both Node.js and
 * Workers without pulling in a dependency.
 */
function hkdfBase64(ikm: string, info: string, length: number): string {
  const salt = Buffer.from("henna", "utf8");
  const prk = createHmac("sha256", salt).update(Buffer.from(ikm, "utf8")).digest();

  const out: Buffer[] = [];
  let total = 0;
  let block = Buffer.alloc(0);
  let counter = 1;
  while (total < length) {
    block = createHmac("sha256", prk)
      .update(Buffer.concat([block, Buffer.from(info, "utf8"), Buffer.from([counter])]))
      .digest();
    out.push(block);
    total += block.length;
    counter += 1;
  }
  return Buffer.concat(out).subarray(0, length).toString("base64");
}

export function isProduction(): boolean {
  return getRootConfig().NODE_ENV === "production";
}

/**
 * Public, non-secret origin of the instance. Used for redirect URI building
 * and for the `AUTH_URL` fallback chain.
 */
export function getBaseUrl(fallback = "http://localhost:3000"): string {
  const env = getRootConfig();
  if (env.AUTH_URL) return env.AUTH_URL.replace(/\/$/, "");
  return fallback;
}
