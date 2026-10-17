import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, verifyAccessToken } from "@/lib/auth/session";

/**
 * Middleware.
 *
 * This is an **optimistic redirect only** and is never a security boundary:
 *
 *  - On Cloudflare Workers, Node.js middleware does not run at all, so every
 *    rule that matters is enforced in the DAL, in Server Actions and in Route
 *    Handlers.
 *  - Even where it does run, it only looks at the shape of a cookie to save an
 *    authenticated user a wasted render. It never decides access.
 *
 * Anything that needs a real decision calls `requirePrincipal()` or
 * `requireAdmin()` from lib/dal/guards.ts.
 */

const PUBLIC_PATHS = new Set([
  "/login",
  "/mfa",
  "/api/auth/github",
  "/api/auth/callback/github",
  "/api/health",
]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const claims = token ? await verifyAccessToken(token) : null;

  if (!claims) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Optimistic only: the DAL re-reads the session row and the user record.
  if (!claims.mfa && !pathname.startsWith("/mfa")) {
    return NextResponse.redirect(new URL("/mfa", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
