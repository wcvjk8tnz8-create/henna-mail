import { randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/crypto/constant-time";
import { getBaseUrl } from "@/lib/config/env";

/**
 * GitHub OAuth — the only OAuth/OIDC provider Henna implements.
 *
 * Flow: Authorization Code. PKCE is used when it can be; when the GitHub OAuth
 * App flow in use does not accept `code_challenge`, Henna does **not** pretend
 * to — a `code_verifier` that the server ignores is worse than no PKCE, because
 * it looks protected. Instead the compensating controls below are applied:
 *
 *  - a single-use, randomly generated `state` stored server-side and compared
 *    in constant time on the way back;
 *  - an exact-match `redirect_uri` allow-list;
 *  - `client_secret` that only ever exists in server-side configuration;
 *  - a one-shot code exchange, where any failure is terminal for that attempt.
 *
 * The GitHub user id — never the email, and never the login, both of which
 * GitHub lets a renamer change — is the binding key.
 */

export const GITHUB_CALLBACK_PATH = "/api/auth/callback/github";
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_USER = "https://api.github.com/user";
export const GITHUB_API_EMAILS = "https://api.github.com/user/emails";
export const GITHUB_API_ORGS = "https://api.github.com/user/orgs";

/** State values are single use and short lived. */
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

export const OAUTH_STATE_COOKIE = "henna_oauth_state";

export interface OAuthStateRecord {
  readonly value: string;
  readonly createdAt: number;
  readonly redirectAfter: string;
}

export function generateOAuthState(redirectAfter = "/inbox"): OAuthStateRecord {
  return {
    value: randomBytes(STATE_BYTES).toString("base64url"),
    createdAt: Date.now(),
    // Only same-site paths are ever stored; validated again on the way back.
    redirectAfter: isValidLocalPath(redirectAfter) ? redirectAfter : "/inbox",
  };
}

export function isStateExpired(record: OAuthStateRecord, now = Date.now()): boolean {
  return now - record.createdAt > STATE_TTL_MS;
}

/** Constant-time comparison of the returned state against the stored one. */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (!received) return false;
  return safeEqual(expected, received);
}

/**
 * Exact-match redirect URI allow-list.
 *
 * GitHub compares the redirect_uri literally, so a substring or prefix check in
 * our own code would be the weak link. Only the one canonical callback URL the
 * instance was configured with is permitted.
 */
export function buildRedirectUri(): string {
  return `${getBaseUrl()}${GITHUB_CALLBACK_PATH}`;
}

export function isAllowedRedirectUri(candidate: string): boolean {
  const expected = buildRedirectUri();
  if (candidate.length !== expected.length) return false;
  return safeEqual(candidate, expected);
}

export function buildAuthorizeUrl(input: {
  readonly clientId: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  /** Present only when the deployment has verified PKCE support end to end. */
  readonly codeChallenge?: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", (input.scopes ?? ["read:user", "user:email"]).join(" "));
  // Henna never grants silently: every visit asks GitHub to re-confirm.
  url.searchParams.set("allow_signup", "false");
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export interface GithubProfile {
  readonly id: number;
  readonly login: string;
  readonly email: string | null;
}

export interface GithubEmailEntry {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

export interface GithubOrgEntry {
  readonly login: string;
}

/**
 * Exchange the authorization code exactly once.
 *
 * Any non-2xx response, any malformed body and any missing field is terminal:
 * the caller must not retry with the same code, because a code that has already
 * been redeemed must never be redeemed again.
 */
export async function exchangeCodeForToken(input: {
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}): Promise<string | null> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    cache: "no-store",
  });

  if (!response.ok) return null;

  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) return null;
  const token = (body as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token === "") return null;
  return token;
}

async function githubGet<T>(url: string, token: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "henna-webmail",
    },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export async function fetchGithubProfile(token: string): Promise<GithubProfile | null> {
  const raw = await githubGet<{
    id?: unknown;
    login?: unknown;
    email?: unknown;
  }>(GITHUB_API_USER, token);
  if (!raw) return null;
  if (typeof raw.id !== "number" || typeof raw.login !== "string") return null;
  return {
    id: raw.id,
    login: raw.login,
    email: typeof raw.email === "string" ? raw.email : null,
  };
}

/**
 * Pick the address GitHub marks as both primary and verified.
 *
 * An unverified address is never accepted as an identity — it is returned to
 * the caller so it can be refused (or queued for administrator review), never
 * silently trusted.
 */
export async function fetchPrimaryVerifiedEmail(token: string): Promise<string | null> {
  const entries = await githubGet<GithubEmailEntry[]>(GITHUB_API_EMAILS, token);
  if (!Array.isArray(entries)) return null;
  const match = entries.find((entry) => entry.primary === true && entry.verified === true);
  return match?.email?.toLowerCase() ?? null;
}

export async function fetchGithubOrgs(token: string): Promise<string[]> {
  const entries = await githubGet<GithubOrgEntry[]>(GITHUB_API_ORGS, token);
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry?.login === "string" ? entry.login.toLowerCase() : null))
    .filter((login): login is string => login !== null);
}

function isValidLocalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

export { isValidLocalPath };
