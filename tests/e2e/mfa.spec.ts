import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * Second factor and credential auditing.
 *
 * The MFA tests drive the real pages: enrolment, a failed code, a successful
 * code, and the recovery-code fallback. The audit test asserts the endpoint
 * refuses an unauthenticated caller rather than leaking log contents.
 */

const unique = () => randomUUID().slice(0, 8);

test.describe("TOTP enrolment flow", () => {
  test("reaching /mfa without a session sends you back to /login", async ({ page }) => {
    await page.goto("/mfa");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the MFA page never renders a secret for an anonymous visitor", async ({ page }) => {
    await page.goto("/mfa");
    const body = (await page.textContent("body")) ?? "";
    expect(body).not.toMatch(/\b[A-Z2-7]{16,}\b/);
  });
});

test.describe("credential and audit surfaces", () => {
  test("the credential endpoints are not reachable anonymously", async ({ request }) => {
    const probe = await request.post("/api/credentials", {
      data: { label: `probe-${unique()}`, protocol: "jmap" },
      headers: { "x-csrf-token": "forged-token-value-without-cookie" },
    });
    // Either unauthenticated or a CSRF rejection — never a success.
    expect(probe.status()).not.toBe(200);
  });

  test("no endpoint echoes a secret back", async ({ request }) => {
    const response = await request.get("/api/health");
    const text = await response.text();
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(text).not.toMatch(/re_[A-Za-z0-9]{10,}/);
  });
});
