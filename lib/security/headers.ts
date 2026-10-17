/**
 * HTTP security headers.
 *
 * Applied from `next.config.ts` for every response, and re-applied by the
 * Cloudflare Worker entry so that static assets served at the edge carry them
 * too.
 *
 * The Content-Security-Policy is the strictest part: scripts are same-origin
 * only (with a per-request nonce where an inline script is unavoidable), frames
 * are limited to upstream mail origins, and `connect-src` is extended at
 * runtime with the JMAP endpoint the user configured. Mail HTML is never
 * covered by this policy — it is rendered inside a sandboxed iframe that bans
 * scripts outright (see lib/mail/sanitize.ts).
 */

export interface HeaderContext {
  /** Per-request nonce for any inline script. */
  readonly nonce?: string;
  /** Upstream mail origins the browser must be able to reach directly. */
  readonly mailOrigins?: readonly string[];
  /**
   * Object storage origins the browser PUTs and GETs attachments against.
   * These belong in `connect-src` only — nothing from the bucket is framed.
   */
  readonly storageOrigins?: readonly string[];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(context: HeaderContext = {}): string {
  const connectSources = new Set<string>(["'self'"]);
  const frameSources = new Set<string>(["'self'"]);

  for (const raw of context.mailOrigins ?? []) {
    const origin = originOf(raw);
    if (origin && origin !== "null") {
      connectSources.add(origin);
      frameSources.add(origin);
    }
  }

  for (const raw of context.storageOrigins ?? []) {
    const origin = originOf(raw);
    if (origin && origin !== "null") connectSources.add(origin);
  }

  const scriptSrc = ["'self'"];
  if (context.nonce) scriptSrc.push(`'nonce-${context.nonce}'`);

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    // `unsafe-inline` is limited to styles; no inline script is ever emitted.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // Mail bodies are rendered in a sandboxed iframe; no font or media loading
    // from arbitrary origins.
    "font-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-src ${[...frameSources].join(" ")}`,
    `connect-src ${[...connectSources].join(" ")}`,
    // GitHub is the only external identity provider Henna talks to.
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildSecurityHeaders(context: HeaderContext & { secure: boolean }): Headers {
  const headers = new Headers();
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(context));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (context.secure) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return headers;
}

/**
 * Headers for the sandboxed iframe that renders a mail body.
 *
 * The critical rule: `allow-scripts` and `allow-same-origin` are never
 * combined, because together they would let the message break out of its
 * sandbox and touch Henna's origin.
 */
export const MAIL_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export function mailIframeHeaders(cspNonce?: string): Headers {
  const headers = new Headers();
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      cspNonce ? `script-src 'nonce-${cspNonce}'` : "script-src 'none'",
      "style-src 'unsafe-inline'",
      // Remote images stay blocked by default; the reader unblocks per message.
      "img-src data:",
      "font-src data:",
      "navigate-to 'none'",
    ].join("; "),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}
