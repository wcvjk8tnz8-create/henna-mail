import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests run in a Node.js environment.
 *
 * These cover the pure, security-critical modules: crypto, password hashing,
 * TOTP, recovery codes, email OTP rules, Zod boundaries, configuration parsing
 * and the DAL's authorisation decisions. Anything that needs a browser, a
 * database or a real OAuth round-trip lives in tests/e2e.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", ".open-next/**"],
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      reporter: ["text", "lcov"],
    },
    /**
     * Unit tests exercise the D1 dialect unless a test overrides it.
     *
     * `db/schema.ts` picks its tables at module load, so this has to be set
     * before the first import rather than inside a test. It matters for
     * `d1-integration.test.ts`, which runs the real DAL against a real SQLite
     * engine: the point of that file is to prove the D1 schema is a drop-in
     * replacement for the PostgreSQL one, which is only true if the DAL is
     * actually handed the D1 table objects.
     */
    env: { HENNA_DB_KIND: "d1" },
    // Security tests must not be flaky; run files in isolation by default.
    pool: "forks",
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
