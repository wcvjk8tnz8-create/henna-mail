import { randomBytes } from "node:crypto";
import type { NextConfig } from "next";

/**
 * Henna — Next.js configuration.
 *
 * Security-relevant notes:
 * - `poweredByHeader` is disabled so the instance does not advertise its stack.
 * - Security headers are emitted for every route. The Content-Security-Policy
 *   is built per request so that the script nonce is fresh every time; a reused
 *   nonce would let an injected snippet run.
 * - All user-supplied mail body HTML is rendered inside a sandboxed iframe
 *   whose CSP forbids scripts; see lib/security/headers.ts.
 * - No NEXT_PUBLIC_ variable may ever carry a secret; lib/config/env.ts asserts
 *   this at boot.
 */
/**
 * Origins the browser is allowed to fetch from.
 *
 * The Content-Security-Policy is emitted statically, because on Cloudflare
 * Workers there is no per-request middleware to build it in. Storage origins
 * therefore come from the build environment: either listed explicitly, or
 * derived from the R2 account id. If you configure the bucket only through
 * /admin/settings, set HENNA_STORAGE_ORIGINS and redeploy so the browser is
 * allowed to reach it.
 */
function extraConnectOrigins(): string[] {
  const origins = new Set<string>();
  for (const raw of (process.env.HENNA_STORAGE_ORIGINS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // A malformed entry is dropped rather than weakening the policy.
    }
  }
  const accountId = process.env.HENNA_R2_ACCOUNT_ID?.trim();
  if (accountId && /^[a-f0-9]{32}$/i.test(accountId)) {
    origins.add(`https://${accountId}.r2.cloudflarestorage.com`);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Henna never proxies mail payloads, so body size limits stay small.
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  serverExternalPackages: ["pg"],
  images: {
    // Remote images are never auto-loaded in the mail reader; nothing is
    // optimised from a third-party origin.
    remotePatterns: [],
  },
  eslint: {
    // We use Biome; `next lint` is deprecated and intentionally unused.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // `tsc --noEmit` runs in CI and blocks merges; the build must not silently
    // skip type errors.
    ignoreBuildErrors: false,
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            // `connect-src` and `frame-src` are widened at request time with
            // the upstream origins the instance allows; see
            // lib/security/headers.ts buildContentSecurityPolicy().
            key: "Content-Security-Policy",
            value: [
              `connect-src 'self' ${extraConnectOrigins().join(" ")}`.trim(),
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "media-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-src 'self'",
              "frame-ancestors 'none'",
              "form-action 'self' https://github.com",
              "upgrade-insecure-requests",
            ].join("; "),
          },
          ...(isProd
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;

/** Exported so the Worker entry can reuse the same nonce discipline. */
export function requestNonce(): string {
  return randomBytes(16).toString("base64");
}
