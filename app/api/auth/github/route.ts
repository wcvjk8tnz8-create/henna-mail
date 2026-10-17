import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getBaseUrl, rawEnv } from "@/lib/config/env";
import { getInstanceSecrets, getInstanceSettings } from "@/lib/config/settings";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  buildRedirectUri,
  generateOAuthState,
} from "@/lib/auth/github";

/**
 * Start the GitHub OAuth flow — the only OAuth provider Henna implements.
 *
 * A single-use `state` is generated here and stored in a server-readable cookie
 * scoped to the callback path. PKCE is attached only when the instance has been
 * configured with it; Henna never sends a `code_challenge` it cannot verify.
 */
export async function GET(request: NextRequest) {
  const settings = await getInstanceSettings();
  if (!settings.authMethods.includes("github")) {
    return NextResponse.redirect(new URL("/login?error=denied", getBaseUrl(request.nextUrl.origin)));
  }

  const secrets = await getInstanceSecrets();
  const clientId = settings.githubClientId ?? rawEnv().GITHUB_CLIENT_ID;
  const clientSecret = secrets.githubClientSecret ?? rawEnv().GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/login?error=denied", getBaseUrl(request.nextUrl.origin)));
  }

  const nextParam = request.nextUrl.searchParams.get("next");
  const nextPath =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/inbox";

  const state = generateOAuthState(nextPath);
  const jar = await cookies();
  const isProd = process.env.NODE_ENV === "production";

  jar.set(OAUTH_STATE_COOKIE, JSON.stringify(state), {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const url = buildAuthorizeUrl({
    clientId,
    state: state.value,
    redirectUri: buildRedirectUri(),
  });

  return NextResponse.redirect(url);
}
