import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * Migrations are generated from db/schema.ts and applied with `drizzle-kit
 * migrate` (see docs/self-hosting.md). The generated SQL is committed so a
 * deployment never depends on generating it at build time.
 */
export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/henna",
  },
  strict: true,
  verbose: true,
} satisfies Config;
