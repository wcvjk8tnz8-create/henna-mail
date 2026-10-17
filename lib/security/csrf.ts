import { createHmac, randomBytes } from "node:crypto";
import { getJwtSecret } from "@/lib/config/env";
import { safeEqual } from "@/lib/crypto/constant-time";

/**
 * CSRF protection for custom Route Handlers.
 *
 * Next.js guards Server Actions automatically and that protection is never
 * disabled anywhere in Henna. Route Handlers that we write ourselves get an
 * explicit double-submit check: a random token is set in a cookie and must be
 * echoed in the `x-csrf-token` header, compared in constant time.
 *
 * The token is bound to the session id so that a token minted for one session
 * cannot be replayed against another.
 */

export const CSRF_COOKIE = "henna_csrf";
export const CSRF_HEADER = "x-csrf-token";

const TOKEN_BYTES = 32;

function hmac(value: string): string {
  return createHmac("sha256", getJwtSecret()).update(`csrf:${value}`).digest("base64url");
}

/** Mint a token bound to the caller's session. */
export function issueCsrfToken(sessionId: string): string {
  const nonce = randomBytes(TOKEN_BYTES).toString("base64url");
  return `${nonce}.${hmac(`${nonce}:${sessionId}`)}`;
}

/**
 * Validate a presented token against the cookie value and the session.
 *
 * Both comparisons are constant time and the whole check is all-or-nothing:
 * a malformed token, a wrong signature or a token bound to another session all
 * return false, and the caller responds 403.
 */
export function validateCsrfToken(input: {
  readonly cookieValue: string | null | undefined;
  readonly headerValue: string | null | undefined;
  readonly sessionId: string | null;
}): boolean {
  const cookie = input.cookieValue;
  const header = input.headerValue;
  if (!cookie || !header) return false;
  if (cookie.length > 512 || header.length > 512) return false;

  // Double submit: the header must match the cookie exactly.
  if (!safeEqual(cookie, header)) return false;

  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  const [nonce, signature] = parts as [string, string];
  if (!nonce || !signature) return false;

  const expected = hmac(`${nonce}:${input.sessionId ?? "anonymous"}`);
  return safeEqual(signature, expected);
}

/** Cookie attributes for the CSRF cookie. */
export function csrfCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: 60 * 60 * 8,
  };
}
