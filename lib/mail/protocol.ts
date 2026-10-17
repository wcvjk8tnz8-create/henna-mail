/**
 * Mail protocol abstraction.
 *
 * Henna's server never stores, proxies or logs mail content. What it does do is
 * hand the browser enough information to talk to the upstream server itself:
 *
 *  - JMAP path: the browser calls the JMAP session endpoint directly with the
 *    user's API token. The server only performs endpoint discovery and a health
 *    check, and even that is restricted to administrator-allow-listed domains.
 *  - IMAP/SMTP path: raw sockets are impossible on Cloudflare Workers, so the
 *    credential is decrypted in memory for a short window and the connection is
 *    brokered. Payloads pass through memory only — never a database, never a
 *    log line. This path is only offered on self-hosted Node.js deployments.
 *
 * Both paths are described by the same interface so the UI does not care which
 * one is in use.
 */

export type MailProtocol = "jmap" | "imap";

export interface MailAccountConfig {
  readonly protocol: MailProtocol;
  readonly endpoint: string;
  readonly port: number | null;
  readonly username: string;
}

export interface ServerCapabilityReport {
  readonly protocol: MailProtocol;
  readonly reachable: boolean;
  readonly details: string;
  /** Only set for JMAP: the session URL the browser should use. */
  readonly sessionUrl?: string;
}

/** Ports Henna will ever connect to. 25 is refused: no unauthenticated relay. */
export const ALLOWED_SMTP_PORTS = [465, 587] as const;
export const ALLOWED_IMAP_PORTS = [143, 993] as const;

export function isAllowedMailPort(port: number): boolean {
  return (
    (ALLOWED_SMTP_PORTS as readonly number[]).includes(port) ||
    (ALLOWED_IMAP_PORTS as readonly number[]).includes(port)
  );
}

/**
 * Whether the runtime can host a raw socket connection.
 *
 * Cloudflare Workers has no raw TCP, so the IMAP/SMTP fallback is unavailable
 * there by design — Henna says so explicitly rather than failing obscurely.
 */
export type RuntimeKind = "workers" | "node";

export function supportsImapFallback(runtime: RuntimeKind): boolean {
  return runtime === "node";
}

export const JMAP_WELL_KNOWN_PATH = "/.well-known/jmap";

/**
 * Endpoint discovery.
 *
 * SSRF defence: the caller must supply a host from the instance allow-list.
 * Henna will not probe an arbitrary hostname supplied by a user.
 */
export function buildWellKnownUrl(host: string): string | null {
  if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.includes("..")) {
    return null;
  }
  return `https://${host}${JMAP_WELL_KNOWN_PATH}`;
}

/**
 * JMAP session discovery performed *by the browser* in production.
 *
 * The server-side variant exists only for the administrator's health check.
 */
export async function probeJmapSession(
  wellKnownUrl: string,
  signal?: AbortSignal,
): Promise<ServerCapabilityReport> {
  try {
    const response = await fetch(wellKnownUrl, {
      redirect: "follow",
      signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return { protocol: "jmap", reachable: false, details: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return { protocol: "jmap", reachable: false, details: "Malformed session document" };
    }
    const sessionUrl = (body as { apiUrl?: unknown }).apiUrl;
    if (typeof sessionUrl !== "string") {
      return { protocol: "jmap", reachable: false, details: "Session document has no apiUrl" };
    }
    return { protocol: "jmap", reachable: true, details: "ok", sessionUrl };
  } catch (error) {
    return {
      protocol: "jmap",
      reachable: false,
      details: error instanceof Error ? error.message : "unreachable",
    };
  }
}

/**
 * The shape handed to the browser so it can drive JMAP itself.
 * No credential is included when the user supplies their own API token.
 */
export interface BrowserMailConfig {
  readonly protocol: MailProtocol;
  readonly endpoint: string;
  readonly username: string;
  /** True when the browser already holds the token and needs nothing from us. */
  readonly browserHoldsCredential: boolean;
}

export function toBrowserMailConfig(config: MailAccountConfig): BrowserMailConfig {
  return {
    protocol: config.protocol,
    endpoint: config.endpoint,
    username: config.username,
    browserHoldsCredential: config.protocol === "jmap",
  };
}
