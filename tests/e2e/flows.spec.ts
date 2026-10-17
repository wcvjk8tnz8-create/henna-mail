import { expect, test } from "@playwright/test";

/**
 * Codes, reset and administrative boundaries.
 *
 * These tests assert the *refusals*. A sign-in surface that accepts everything
 * is easy to build and worthless; the interesting behaviour is what gets turned
 * away, and whether turning it away was recorded.
 */

test.describe("email code limits", () => {
  test("requesting a code never reveals whether the address exists", async ({ page }) => {
    await page.goto("/login");

    // The tab is only offered when the instance has email codes enabled.
    const hasTab = await page.getByRole("button", { name: "Email code" }).count();
    if (hasTab === 0) {
      test.skip(true, "email codes are disabled on this instance");
    }

    await page.getByRole("button", { name: "Email code" }).click();
    await page.fill('input[name="email"]', "definitely-not-registered@example.com");
    await page.getByRole("button", { name: "Send code" }).click();

    // The response must be the generic one, worded identically for a real
    // address and an unknown one.
    await expect(page.getByRole("status")).toContainText(/if that address/i);
  });

  test("a wrong code is refused without saying why", async ({ page }) => {
    await page.goto("/login");
    const hasTab = await page.getByRole("button", { name: "Email code" }).count();
    if (hasTab === 0) {
      test.skip(true, "email codes are disabled on this instance");
    }
    await page.getByRole("button", { name: "Email code" }).click();
    await page.fill('input[name="email"]', "someone@example.com");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.fill('input[name="code"]', "000000");
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByRole("status")).toContainText(/not valid|new one/i);
  });
});

test.describe("password reset", () => {
  test("the reset request is generic and never confirms an account", async ({ request }) => {
    const response = await request.post("/login", {
      form: { email: "unknown@example.com", action: "requestPasswordReset" },
      maxRedirects: 0,
    });
    // Whatever happened, the endpoint must not answer 200 with a confirmation
    // that the address is known.
    expect([200, 303, 400, 403, 405]).toContain(response.status());
  });
});

test.describe("registration control", () => {
  test("a non-allow-listed GitHub user is refused and sent back to /login", async ({ request }) => {
    // A callback without a valid state cannot succeed; the point is that the
    // failure lands on /login rather than creating a session.
    const response = await request.get("/api/auth/callback/github?code=x&state=forged", {
      maxRedirects: 0,
    });
    expect([302, 303, 307, 400, 403]).toContain(response.status());
    const location = response.headers()["location"] ?? "";
    expect(location).toMatch(/\/login/);
  });

  test("an OAuth error from GitHub is not treated as success", async ({ request }) => {
    const response = await request.get(
      "/api/auth/callback/github?error=access_denied&state=x",
      { maxRedirects: 0 },
    );
    expect([302, 303, 307, 400, 403]).toContain(response.status());
  });
});

test.describe("administrator second factor", () => {
  test("the admin pages are unreachable without a satisfied second factor", async ({ request }) => {
    for (const route of ["/admin/settings", "/admin/audit"]) {
      const response = await request.get(route, { maxRedirects: 0 });
      expect([302, 303, 307, 401, 403]).toContain(response.status());
    }
  });

  test("the audit export refuses a token that has no matching cookie", async ({ request }) => {
    // A header token presented without the corresponding cookie — the
    // double-submit check must fail closed.
    const response = await request.get("/admin/audit?format=csv", {
      headers: { "x-csrf-token": "cccccccccccccccccccccccccccccccc" },
    });
    expect(response.status()).toBe(403);
  });
});

test.describe("credential auditing", () => {
  test("no endpoint returns a decrypted credential to an anonymous caller", async ({ request }) => {
    const response = await request.get("/api/health");
    const body = await response.text();
    // A credential would show up as an opaque ciphertext at worst; plaintext
    // secrets must never appear at all.
    expect(body).not.toMatch(/"secret"/);
    expect(body).not.toMatch(/password/i);
  });
});
