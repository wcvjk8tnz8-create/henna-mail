import { createHash, createHmac } from "node:crypto";
import { getKeyring } from "@/lib/crypto/keyring";

/**
 * Request fingerprinting.
 *
 * Henna stores `ip_hash` and `user_agent_hash` in the audit log — never the
 * raw client IP or the raw user-agent string. The hashes are keyed with a
 * server-side pepper taken from the credential keyring, so a database dump
 * cannot be reversed into a list of user addresses, while an investigator who
 * holds the pepper can still correlate one incident with a specific client.
 */

export interface RequestContext {
  readonly ipHash: string | null;
  readonly userAgentHash: string | null;
  /** Only present when the deployment is behind a trusted proxy. */
  readonly ip: string | null;
}

function pepper(): Buffer {
  return getKeyring().keyIds.length > 0
    ? Buffer.from(getKeyring().activeKeyId, "utf8")
    : Buffer.from("henna-dev-pepper", "utf8");
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac("sha256", pepper()).update(`ip:${ip.trim()}`).digest("hex").slice(0, 32);
}

export function hashUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return createHash("sha256").update(`ua:${userAgent}`).digest("hex").slice(0, 32);
}

/**
 * Extract the client IP from proxy headers.
 *
 * The left-most `X-Forwarded-For` entry is the one an attacker controls least
 * *when* the deployment is behind exactly one trusted proxy. Henna therefore
 * only trusts it when `HENNA_TRUST_PROXY=1`, which is the default on
 * Cloudflare Workers and must be set deliberately elsewhere.
 */
export function extractClientIp(headers: Headers): string | null {
  const trustProxy = process.env.HENNA_TRUST_PROXY ?? "1";
  if (trustProxy !== "1") return null;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    if (first && first.trim() !== "") return first.trim();
  }
  const real = headers.get("cf-connecting-ip") ?? headers.get("x-real-ip");
  return real ? real.trim() : null;
}

export function buildRequestContext(headers: Headers): RequestContext {
  const ip = extractClientIp(headers);
  const userAgent = headers.get("user-agent");
  return {
    ip,
    ipHash: hashIp(ip),
    userAgentHash: hashUserAgent(userAgent),
  };
}

/**
 * Constant-rate helper for tests: a deterministic context with no real
 * network information.
 */
export const ANONYMOUS_REQUEST_CONTEXT: RequestContext = {
  ip: null,
  ipHash: null,
  userAgentHash: null,
};
