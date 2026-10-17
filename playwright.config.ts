import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * These exercise the boundaries that matter: the three sign-in methods, the
 * second factor, cross-user authorisation, CSRF on custom Route Handlers, and
 * whether credential decryption is actually audited.
 *
 * Run against a real PostgreSQL instance. `npm run test:e2e` uses the local dev
 * server; CI provides DATABASE_URL and the root environment through secrets.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "list" : "html",
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
