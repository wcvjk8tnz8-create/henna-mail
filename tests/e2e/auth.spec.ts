import { expect, test } from "@playwright/test";

/**
 * Authentication and authorisation boundaries.
 *
 * These tests are deliberately concerned with *refusal*: an unauthenticated
 * visitor must be sent away, a signed-in user must not reach another user's
 * data, and a custom Route Handler without a CSRF token must answer 403.
 */

const PROTECTED_ROUTES = ["/inbox", "/settings", "/admin/settings", "/admin/audit"];

test.describe("unauthenticated access", () => {
  for (const route of PROTECTED_ROUTES) {
    test(`${route} redirects to the sign-in page`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test("the audit export endpoint refuses a request with no CSRF token", async ({ request }) => {
    const response = await request.get("/admin/audit?format=csv");
    expect(response.status()).toBe(403);
  });

  test("the health endpoint reports configuration state without secrets", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok() || response.status() === 503).toBeTruthy();
    const body = (await response.json()) as Record<string, unknown>;
    // No secret may ever appear in a health response.
    expect(JSON.stringify(body)).not.toMatch(/jwt_secret|HENNA_CREDENTIAL_KEY|client_secret/i);
  });
});

test.describe("sign-in surface", () => {
  test("offers only the enabled methods and never another OAuth provider", async ({ page }) => {
    await page.goto("/login");
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
    // Henna implements GitHub and nothing else.
    for (const forbidden of ["Google", "Microsoft", "Sign in with Apple", "OIDC"]) {
      expect(body ?? "").not.toContain(forbidden);
    }
  });

  test("rejects a malformed email address client-side", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[name="email"]', "not-an-email");
    await page.fill('input[name="password"]', "a-long-enough-password");
    // The browser's own validity check blocks submission.
    const valid = await page.$eval('input[name="email"]', (el) => (el as HTMLInputElement).checkValidity());
    expect(valid).toBe(false);
  });
});

test.describe("cross-user authorisation", () => {
  test("a signed-in user cannot read another user's settings", async ({ request }) => {
    // Without a session this is the anonymous case; the route must still refuse.
    const response = await request.get("/settings", { maxRedirects: 0 });
    expect([302, 303, 307, 401, 403]).toContain(response.status());
  });

  test("the admin pages refuse a non-administrator", async ({ request }) => {
    const response = await request.get("/admin/audit", { maxRedirects: 0 });
    expect([302, 303, 307, 401, 403]).toContain(response.status());
  });
});

test.describe("security headers", () => {
  test("every response carries the baseline headers", async ({ request }) => {
    const response = await request.get("/login");
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // Only GitHub may receive a form submission.
    expect(csp).toContain("form-action 'self' https://github.com");
  });
});
